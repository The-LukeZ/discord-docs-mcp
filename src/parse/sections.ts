import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { createSlugger, slugify } from "./anchors";
import { toMarkdown } from "./mdx";
import type { ParsedSection, SectionUnit } from "./types";

export type { SectionUnit };

// Loose node type, as in mdx.ts.
interface N {
  type: string;
  [k: string]: any;
}

const isHeading = (n: N | undefined, ...depths: number[]): boolean => !!n && n.type === "heading" && depths.includes(n.depth);

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

interface Fence {
  marker: string;
  info: string;
}

/** Fence state after reading `lines`, starting from `state`. */
function fenceAfter(state: Fence | null, lines: string[]): Fence | null {
  for (const l of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (!m) continue;
    if (!state) state = { marker: m[1], info: m[2] };
    else if (m[1][0] === state.marker[0] && m[1].length >= state.marker.length && m[2].trim() === "") state = null;
  }
  return state;
}

/** Header and delimiter rows of a GFM table block, or [] when the block is not a table. */
function tableHead(lines: string[]): string[] {
  const isTable =
    lines.length > 2 && /^\s*\|/.test(lines[0]) && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[1]);
  return isTable ? lines.slice(0, 2) : [];
}

/**
 * Split an oversized block's markdown into pieces of at most ~max chars (plus a small fence allowance).
 * Prefers blank lines, then single newlines, then a hard cut inside a line. A piece that ends inside a
 * code fence is closed with the same marker and the next piece reopens it with the same info string.
 */
function splitText(text: string, max: number): string[] {
  const reserve = 16; // room for a closing fence line
  const budget = Math.max(max - reserve, 1);
  const lines = text.split("\n").flatMap((l) => {
    if (l.length <= budget) return [l];
    const cuts: string[] = [];
    for (let i = 0; i < l.length; i += budget) cuts.push(l.slice(i, i + budget));
    return cuts;
  });
  const out: string[] = [];
  let state: Fence | null = null; // fence open at the start of the current piece
  let cur: string[] = [];
  let len = 0;
  // A table piece without its header and delimiter rows renders as plain text, so repeat them.
  const head = tableHead(lines);
  const open = (): string[] => (state ? [state.marker + state.info] : out.length > 0 ? [...head] : []);
  const emit = (piece: string[]): void => {
    const end = fenceAfter(state, piece);
    out.push([...piece, ...(end ? [end.marker] : [])].join("\n"));
    state = end;
  };
  cur = open();
  len = cur.join("\n").length;
  const startLen = cur.length;
  for (const l of lines) {
    if (cur.length > startLen && len + l.length + 1 > budget) {
      // prefer the last blank line as the break point
      let cut = -1;
      for (let i = cur.length - 1; i > startLen; i--) if (cur[i] === "") { cut = i; break; }
      if (cut > 0) {
        const rest = cur.slice(cut + 1);
        emit(cur.slice(0, cut));
        cur = [...open(), ...rest];
      } else {
        emit(cur);
        cur = open();
      }
      len = cur.join("\n").length;
    }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length > open().length) emit(cur);
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
  nodes.forEach((n) => {
    if (n.type === "manualAnchor") out.push(n.id);
    // A preceding manual anchor does not hide the heading's own slug: both ids exist on the site.
    else if (isHeading(n, 4, 5, 6)) out.push(slugOf(n));
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
      if (!intro && part === 1 && u.manualAnchor && slugOf(u.heading!) !== anchor) subAnchors.unshift(slugOf(u.heading!));
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
