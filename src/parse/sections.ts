import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { createSlugger, slugify } from "./anchors";
import { toMarkdown } from "./mdx";
import type { ParsedSection } from "./types";

// Loose node type, as in mdx.ts.
interface N {
  type: string;
  [k: string]: any;
}

const isHeading = (n: N | undefined, ...depths: number[]): boolean => !!n && n.type === "heading" && depths.includes(n.depth);

/** One H2/H3 (or the intro): its heading plus every block up to the next H2/H3. */
export interface SectionUnit {
  level: 1 | 2 | 3;
  /** explicit `<ManualAnchor>` placed right before the heading, if any */
  manualAnchor?: string;
  /** heading node; null for the intro (the page title is used) */
  heading: N | null;
  /** blocks after the heading; may contain H4-H6 headings and manualAnchor markers */
  body: N[];
}

/**
 * Group top-level blocks by H2/H3. Content before the first H2/H3 (including a `# title`
 * heading, which is dropped in favour of the page title) forms the intro unit.
 * A (non-alias) manualAnchor directly before an H2/H3 attaches to that heading.
 */
export function sectionUnits(tree: Root): SectionUnit[] {
  const kids = tree.children as N[];
  const units: SectionUnit[] = [{ level: 1, heading: null, body: [] }];
  let cur = units[0];
  // Alias anchors (<a id="x"/>) add a second anchor and never replace the heading slug: they belong to the
  // section of the heading that follows them.
  let aliases: N[] = [];
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.type === "manualAnchor" && n.alias) {
      aliases.push(n);
      continue;
    }
    if (n.type === "manualAnchor" && isHeading(kids[i + 1], 2, 3)) {
      const h = kids[++i];
      cur = { level: h.depth, manualAnchor: n.id, heading: h, body: [] };
      units.push(cur);
    } else if (isHeading(n, 2, 3)) {
      cur = { level: n.depth, heading: n, body: [] };
      units.push(cur);
    } else {
      cur.body.push(...aliases, n);
      aliases = [];
      continue;
    }
    cur.body.push(...aliases);
    aliases = [];
  }
  if (aliases.length) cur.body.push(...aliases);
  return units;
}

const md = (nodes: N[]): string => toMarkdown({ type: "root", children: nodes } as unknown as Root).trimEnd();

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Split an oversized block's markdown at blank lines (last resort). */
function splitText(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const piece of text.split("\n\n")) {
    if (cur && cur.length + piece.length + 2 > max) {
      out.push(cur);
      cur = piece;
    } else cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

interface Atom {
  nodes: N[];
  text: string;
}

/** Break a body into packing atoms: segments starting at H4-H6, or single blocks when a segment is too big. */
function atomize(body: N[], max: number): Atom[] {
  // Blocks: manual anchors glue to the node that follows them.
  const blocks: N[][] = [];
  let anchors: N[] = [];
  for (const n of body) {
    if (n.type === "manualAnchor") anchors.push(n);
    else {
      blocks.push([...anchors, n]);
      anchors = [];
    }
  }
  if (anchors.length) blocks.push(anchors);

  const segments: N[][][] = [];
  for (const b of blocks) {
    if (isHeading(b.at(-1), 4, 5, 6) || segments.length === 0) segments.push([b]);
    else segments.at(-1)!.push(b);
  }

  return segments.flatMap((seg) => {
    const text = md(seg.flat());
    if (text.length <= max) return [{ nodes: seg.flat(), text }];
    return seg.flatMap((b) => {
      const t = md(b);
      if (t.length <= max) return [{ nodes: b, text: t }];
      return splitText(t, max).map((p, i) => ({ nodes: i === 0 ? b : [], text: p }));
    });
  });
}

function collectSubAnchors(nodes: N[], slugOf: (n: N) => string): string[] {
  const out: string[] = [];
  nodes.forEach((n, i) => {
    if (n.type === "manualAnchor") out.push(n.id);
    else if (isHeading(n, 4, 5, 6) && (nodes[i - 1]?.type !== "manualAnchor" || nodes[i - 1].alias)) out.push(slugOf(n));
  });
  return out;
}

function prevH2(units: SectionUnit[], ord: number): string {
  for (let i = ord - 1; i >= 0; i--) if (units[i].level === 2) return toString(units[i].heading as never);
  return "";
}

/**
 * Split a cleaned page tree into addressable sections (one per H2/H3, plus the intro).
 * Anchors are page-scoped: slugs are de-duplicated across all heading levels of the page.
 * `ord` is the 0-based position of the section in the page; all parts of a section share it.
 */
export async function splitSections(
  tree: Root,
  page: { path: string; title: string },
  opts: { splitChars: number },
): Promise<ParsedSection[]> {
  const slug = createSlugger();
  const slugs = new Map<N, string>();
  const slugOf = (n: N): string => slugs.get(n) ?? "";
  // Allocate slugs for every heading in document order so dedupe is stable across levels.
  const walk = (nodes: N[]): void => {
    for (const n of nodes) {
      if (n.type === "heading") slugs.set(n, slug(toString(n as never)));
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(tree.children as N[]);

  const area = page.path.split("/")[0];
  const out: ParsedSection[] = [];
  const units = sectionUnits(tree);
  const h1Slugs = (tree.children as N[]).filter((n) => isHeading(n, 1)).map(slugOf);

  for (let ord = 0; ord < units.length; ord++) {
    const u = units[ord];
    const intro = u.heading === null;
    const heading = intro ? page.title : toString(u.heading as never);
    const anchor = intro ? "" : (u.manualAnchor ?? slugOf(u.heading!));
    const headingLine = intro ? `# ${page.title}` : md([u.heading!]);
    const headingPath = intro ? [page.title] : [page.title, ...(u.level === 3 ? [prevH2(units, ord)] : []), heading].filter((x) => x !== "");
    const body = intro ? u.body.filter((n) => !isHeading(n, 1)) : u.body;

    // Pack atoms greedily into parts.
    const parts: Atom[][] = [];
    let size = 0;
    for (const a of atomize(body, opts.splitChars)) {
      const cur = parts.at(-1);
      if (!cur || (size + a.text.length + 2 > opts.splitChars && cur.length > 0)) {
        parts.push([a]);
        size = headingLine.length + a.text.length + 2;
      } else {
        cur.push(a);
        size += a.text.length + 2;
      }
    }
    if (parts.length === 0) parts.push([]);

    const baseId = anchor ? `${page.path}#${anchor}` : page.path;
    for (let i = 0; i < parts.length; i++) {
      const part = i + 1;
      const markdown = [headingLine, ...parts[i].map((a) => a.text).filter((t) => t !== "")].join("\n\n");
      const subAnchors = collectSubAnchors(parts[i].flatMap((a) => a.nodes), slugOf);
      // Links to the page title (`#rate-limits` on "Rate Limits") land on the intro.
      if (intro && part === 1) subAnchors.unshift(...new Set([slugify(page.title), ...h1Slugs].filter((a) => a !== "")));
      out.push({
        id: part === 1 ? baseId : `${baseId}~${part}`,
        baseId,
        pagePath: page.path,
        area,
        anchor,
        heading,
        headingPath,
        level: u.level,
        part,
        ord,
        markdown,
        contentHash: await sha256Hex(markdown),
        subAnchors,
      });
    }
  }
  return out;
}
