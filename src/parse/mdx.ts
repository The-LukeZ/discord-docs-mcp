import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown as mdastToMarkdown } from "mdast-util-to-markdown";
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import { pageUrl } from "./navigation";
import type { CleanResult, Frontmatter, UpdateMeta } from "./types";

export interface CleanContext {
  pagePath: string;
  /** repo path (e.g. "snippets/x/part.mdx") -> source */
  snippets: Map<string, string>;
}

// Loose node type: mdast + mdx-jsx nodes are walked generically.
interface N {
  type: string;
  [k: string]: any;
}

const CALLOUTS = new Set(["Note", "Info", "Tip", "Warning", "Danger", "Check"]);
const TITLED = new Set(["Card", "ImageCard", "Tab", "Accordion", "Step", "ParamField", "ResponseField"]);
const TITLE_ATTRS = ["title", "name", "path", "query", "body", "header"];
const PHRASING = new Set(["text", "html", "emphasis", "strong", "delete", "inlineCode", "break", "link", "image", "linkReference", "imageReference", "footnoteReference"]);
const INLINE_PARENTS = new Set(["heading", "tableCell", "link", "emphasis", "strong", "delete", "linkReference"]);
const FLOW_PARENTS = new Set(["root", "blockquote", "listItem", "footnoteDefinition"]);

interface Shared {
  ctx: CleanContext;
  deps: Set<string>;
  problems: string[];
  /** repo paths of snippets currently being expanded (cycle guard) */
  stack: string[];
}

interface Doc {
  shared: Shared;
  /** local component name -> import specifier */
  imports: Map<string, string>;
}

const mdxProcessor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkMdx).use(remarkGfm);
const plainProcessor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

function attr(el: N, name: string): string | undefined {
  const a = (el.attributes as N[]).find((x) => x.type === "mdxJsxAttribute" && x.name === name);
  return typeof a?.value === "string" ? a.value : undefined;
}

/** Evaluate a literal-only estree node (strings, numbers, booleans, null, arrays, objects). No code execution. */
function evalLiteral(n: N | null | undefined): unknown {
  if (!n) return undefined;
  switch (n.type) {
    case "Literal":
      return n.value;
    case "TemplateLiteral":
      return n.expressions.length === 0 ? n.quasis.map((q: N) => q.value.cooked).join("") : undefined;
    case "ArrayExpression":
      return n.elements.map((e: N | null) => evalLiteral(e));
    case "ObjectExpression": {
      const o: Record<string, unknown> = {};
      for (const p of n.properties as N[]) {
        if (p.type !== "Property" || p.computed) continue;
        const k = p.key.type === "Identifier" ? p.key.name : p.key.value;
        o[String(k)] = evalLiteral(p.value);
      }
      return o;
    }
    default:
      return undefined;
  }
}

/** Value of an expression attribute like tags={[...]} via the estree remark-mdx attaches. */
function jsxExpr(el: N, name: string): unknown {
  const a = (el.attributes as N[]).find((x) => x.type === "mdxJsxAttribute" && x.name === name);
  const stmt = a?.value?.data?.estree?.body?.[0];
  return stmt?.type === "ExpressionStatement" ? evalLiteral(stmt.expression) : undefined;
}

function textOf(n: N): string {
  if (typeof n.value === "string") return n.value;
  return Array.isArray(n.children) ? n.children.map(textOf).join("") : "";
}

/** Longest ESM block inspected. Real import blocks are a few hundred characters; the cap bounds worst-case work. */
const MAX_ESM_CHARS = 20_000;

/**
 * Record `local name -> module specifier` for each static import in an MDX ESM block.
 * Linear time: whitespace runs are collapsed first, then the text is split at each `import` keyword and every
 * piece is matched with an anchored pattern, so no start position rescans the rest of the input.
 * Input beyond MAX_ESM_CHARS is ignored.
 */
export function parseImports(esm: string, into: Map<string, string>): void {
  const text = esm.slice(0, MAX_ESM_CHARS).replace(/\s+/g, " ");
  const pieces = text.split(/(?<![\w$])import(?![\w$])/).slice(1);
  for (const piece of pieces) {
    const m = piece.match(/^\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const clause = m[1]!.trim();
    const spec = m[2]!;
    const def = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (def) into.set(def[1]!, spec);
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      for (const part of named[1]!.split(",")) {
        const local = part.trim().split(/\s+as\s+/).pop();
        if (local) into.set(local, spec);
      }
    }
  }
}

function rewriteUrl(url: string, sh: Shared): string {
  if (url.startsWith("#")) return pageUrl(sh.ctx.pagePath, url.slice(1));
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//") || url.startsWith("?")) return url;
  if (url.startsWith("/")) {
    const m = url.match(/^\/developers(?:\/([^#?]*))?(?:#(.*))?$/);
    if (!m) return url;
    return pageUrl((m[1] ?? "").replace(/\/$/, "").replace(/\.mdx$/, ""), m[2]);
  }
  // relative link: resolve against the page directory
  const [pathPart = "", anchor] = url.split("#");
  const segs = sh.ctx.pagePath.split("/").slice(0, -1);
  for (const s of pathPart.split("/")) {
    if (s === "..") {
      if (!segs.length) return url;
      segs.pop();
    } else if (s !== "." && s !== "") segs.push(s);
  }
  return pageUrl(segs.join("/").replace(/\.mdx$/, ""), anchor);
}

/** Group consecutive phrasing nodes into paragraphs; blocks pass through. */
function toBlocks(nodes: N[]): N[] {
  const out: N[] = [];
  let run: N[] = [];
  const flush = () => {
    if (run.some((n) => n.type !== "text" || n.value.trim())) out.push({ type: "paragraph", children: run });
    run = [];
  };
  for (const n of nodes) {
    if (PHRASING.has(n.type)) run.push(n);
    else {
      flush();
      out.push(n);
    }
  }
  flush();
  return out;
}

/** Placeholder for an image. An `html` node so the brackets are not escaped on output. */
const imageNote = (alt?: string): N[] => {
  const a = alt?.replace(/[\[\]\r\n]+/g, " ").trim();
  return a ? [{ type: "html", value: `[image: ${a}]` }] : [];
};

const strong = (text: string): N => ({ type: "strong", children: [{ type: "text", value: text }] });

function children(parent: N, doc: Doc): N[] {
  const out = (parent.children as N[]).flatMap((c) => transformNode(c, doc));
  if (INLINE_PARENTS.has(parent.type)) {
    // phrasing-only parent: flatten paragraphs, drop blocks; keep anchor markers so the caller can hoist them
    return out.flatMap((n) => (n.type === "paragraph" ? n.children : PHRASING.has(n.type) || n.type === "manualAnchor" ? [n] : []));
  }
  return out;
}

function trimEnd(kids: N[]): N[] {
  const last = kids.filter((k) => k.type !== "manualAnchor").at(-1);
  return last?.type === "text" ? kids.map((k) => (k === last ? { ...k, value: k.value.trimEnd() } : k)) : kids;
}

/** Anchor markers inside inline/heading/table content move to sibling blocks placed BEFORE the container. */
function withHoistedAnchors(node: N, kids: N[]): N[] {
  const anchors = kids.filter((k) => k.type === "manualAnchor");
  return [...anchors, { ...node, children: kids.filter((k) => k.type !== "manualAnchor") }];
}

function transformNode(n: N, doc: Doc): N[] {
  switch (n.type) {
    case "yaml":
    case "mdxjsEsm":
      return [];
    case "html":
      return []; // raw HTML from the plain-markdown fallback
    case "mdxFlowExpression":
    case "mdxTextExpression": {
      const lit = /^\s*(["'`])((?:\\.|(?!\1).)*)\1\s*$/s.exec(n.value);
      return lit ? [{ type: "text", value: lit[2] }] : [];
    }
    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return transformJsx(n, doc);
    case "image":
      return imageNote(n.alt);
    case "link":
      return withHoistedAnchors({ ...n, url: rewriteUrl(n.url, doc.shared) }, children(n, doc));
    case "definition":
      return [{ ...n, url: rewriteUrl(n.url, doc.shared) }];
    case "paragraph":
      // a paragraph may contain JSX that yields blocks (Update, callouts): split it
      return toBlocks(withHoistedAnchors({ type: "paragraph" }, children(n, doc)).flatMap((x) => (x.type === "paragraph" ? x.children : [x])));
    default:
      if (Array.isArray(n.children)) {
        const kids = children(n, doc);
        if (FLOW_PARENTS.has(n.type)) return [{ ...n, children: toBlocks(kids) }];
        return withHoistedAnchors(n, n.type === "heading" ? trimEnd(kids) : kids);
      }
      return [n];
  }
}

function transformJsx(el: N, doc: Doc): N[] {
  const name: string | null = el.name;
  const kids = () => children(el, doc);
  if (name === "ManualAnchor") {
    const id = attr(el, "id");
    return id ? [{ type: "manualAnchor", id }] : [];
  }
  // `<a id="x"/>` (no content) is an extra anchor target; it keeps the heading's own slug valid too
  if (name === "a" && el.children.length === 0 && attr(el, "id")) {
    return [{ type: "manualAnchor", id: attr(el, "id"), alias: true }];
  }
  if (name === "Route") {
    const text = textOf(el).replace(/\s+/g, " ").trim();
    const method = attr(el, "method");
    return [{ type: "inlineCode", value: method ? `${method} ${text}` : text }];
  }
  if (name === "img") {
    return imageNote(attr(el, "alt"));
  }
  if (name && CALLOUTS.has(name)) {
    const blocks = toBlocks(kids());
    const head = strong(`${name}:`);
    if (blocks[0]?.type === "paragraph") blocks[0] = { ...blocks[0], children: [head, { type: "text", value: " " }, ...blocks[0].children] };
    else blocks.unshift({ type: "paragraph", children: [head] });
    return [{ type: "blockquote", children: blocks }];
  }
  if (name === "Update") {
    const label = attr(el, "label") ?? "";
    const update: UpdateMeta = { label, tags: [] };
    const tags = jsxExpr(el, "tags");
    if (Array.isArray(tags)) update.tags = tags.filter((t): t is string => typeof t === "string");
    const rss = jsxExpr(el, "rss");
    if (rss && typeof rss === "object" && !Array.isArray(rss)) {
      const r = rss as Record<string, unknown>;
      if (typeof r.title === "string") update.rssTitle = r.title;
      if (typeof r.description === "string") update.rssDescription = r.description;
    }
    return [{ type: "heading", depth: 2, children: [{ type: "text", value: label }], data: { update } }, ...toBlocks(kids())];
  }
  if (name && TITLED.has(name)) {
    const key = TITLE_ATTRS.find((k) => attr(el, k));
    const title = key ? attr(el, key)! : "";
    return title ? [{ type: "paragraph", children: [strong(title)] }, ...toBlocks(kids())] : kids();
  }
  const spec = name ? doc.imports.get(name) : undefined;
  if (spec !== undefined) return inlineSnippet(spec, doc.shared);
  return kids();
}

function inlineSnippet(spec: string, sh: Shared): N[] {
  if (!spec.endsWith(".mdx")) return []; // .jsx/.js components render client-side; nothing to inline
  const repoPath = spec.replace(/^\/+/, "");
  const src = sh.ctx.snippets.get(repoPath);
  if (src === undefined) {
    sh.problems.push(`missing snippet: ${repoPath}`);
    return [];
  }
  if (sh.stack.includes(repoPath)) {
    sh.problems.push(`snippet import cycle: ${[...sh.stack, repoPath].join(" -> ")}`);
    return [];
  }
  sh.deps.add(repoPath);
  sh.stack.push(repoPath);
  try {
    return parseAndClean(src, sh).tree.children as N[];
  } finally {
    sh.stack.pop();
  }
}

/** Last resort when remark-mdx rejects the file: drop imports, tags and expressions, parse as markdown. */
function stripToPlain(source: string): string {
  return source
    .replace(/^import\s.*$/gm, "")
    .replace(/<\/?[A-Za-z][^<>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function parseAndClean(source: string, sh: Shared): { tree: Root; frontmatter: Frontmatter } {
  let parsed: Root;
  try {
    parsed = mdxProcessor.runSync(mdxProcessor.parse(source)) as Root;
  } catch (e) {
    sh.problems.push(`mdx parse failed (${sh.stack.at(-1) ?? sh.ctx.pagePath}): ${(e as Error).message.split("\n")[0]}; used plain-markdown fallback`);
    parsed = plainProcessor.parse(stripToPlain(source)) as Root;
  }
  const doc: Doc = { shared: sh, imports: new Map() };
  const frontmatter: Frontmatter = {};
  for (const n of parsed.children as N[]) {
    if (n.type === "mdxjsEsm") parseImports(n.value, doc.imports);
    else if (n.type === "yaml") {
      try {
        const y = parseYaml(n.value) as Record<string, unknown> | null;
        for (const k of ["title", "sidebarTitle", "description"] as const) {
          const v = y?.[k];
          if (typeof v === "string") frontmatter[k] = v;
        }
      } catch (e) {
        sh.problems.push(`frontmatter yaml invalid: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  const kids = children(parsed as unknown as N, doc);
  return { tree: { type: "root", children: toBlocks(kids) } as Root, frontmatter };
}

export function cleanMdx(source: string, ctx: CleanContext): CleanResult {
  const sh: Shared = { ctx, deps: new Set(), problems: [], stack: [] };
  const { tree, frontmatter } = parseAndClean(source, sh);
  return { frontmatter, tree, snippetDeps: [...sh.deps], problems: sh.problems };
}

export function toMarkdown(tree: Root): string {
  const strip = (n: N): N => (Array.isArray(n.children) ? { ...n, children: n.children.filter((c: N) => c.type !== "manualAnchor").map(strip) } : n);
  return mdastToMarkdown(strip(tree as unknown as N) as unknown as Root, {
    extensions: [gfmToMarkdown()],
    bullet: "-",
    emphasis: "*",
    fences: true,
    rule: "-",
  });
}
