import { toString } from "mdast-util-to-string";
import { toMarkdown } from "./mdx";
import type {
  MdNode,
  ParamTable,
  ParsedEndpoint,
  ParsedEnum,
  ParsedField,
  ParsedObject,
  ParsedSection,
  SectionUnit,
} from "./types";

export interface ExtractedEntities {
  endpoints: ParsedEndpoint[];
  objects: ParsedObject[];
  enums: ParsedEnum[];
  problems: string[];
}

/**
 * Canonical form of an endpoint path for exact matching: origin, `/api`, `/v<n>`, query/hash and trailing
 * slash are dropped, every `{...}` or all-digit segment becomes `{}`, lowercase.
 */
export function normalizePath(path: string): string {
  let p = path.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "");
  p = p.replace(/[?#].*$/, "");
  p = p.replace(/^\/api(?=\/|$)/i, "").replace(/^\/v\d+(?=\/|$)/i, "");
  const segs = p.split("/").filter((s) => s !== "");
  const out = segs.map((s) => (/^\d+$/.test(s) || /^\{[^}]*\}$/.test(s) ? "{}" : s.replace(/\{[^}]*\}/g, "{}")).toLowerCase());
  return "/" + out.join("/");
}

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/;
const FOOTNOTE = /\s*(\*+|[†‡§])$/;

const text = (n: unknown): string => toString(n as never).replace(/\s+/g, " ").trim();
const md = (n: MdNode): string => toMarkdown({ type: "root", children: [n] } as never);

/** Split a trailing footnote marker (`*`, `**`, `†`) off a cell. */
function splitFootnote(s: string): { text: string; marks: string[] } {
  const m = FOOTNOTE.exec(s);
  if (!m) return { text: s, marks: [] };
  return { text: s.slice(0, m.index).trim(), marks: [m[1].split("\\").join("")] };
}

interface Table {
  columns: string[];
  rows: string[][];
}

function readTable(node: MdNode): Table {
  const rows = (node.children as MdNode[]).map((r) => (r.children as MdNode[]).map(text));
  if (rows.length === 0) throw new Error("empty table");
  return { columns: rows[0], rows: rows.slice(1) };
}

const STRUCT = /^(.+) Structure$/;

function looksLikeFields(t: Table): boolean {
  const lower = t.columns.map((c) => c.toLowerCase());
  return ["field", "name"].includes(lower[0]) && lower.includes("type");
}

function parseFields(t: Table): ParsedField[] {
  const lower = t.columns.map((c) => c.toLowerCase());
  const typeIdx = lower.indexOf("type");
  if (!["field", "name"].includes(lower[0]) || typeIdx < 0) throw new Error(`unexpected columns [${t.columns.join(", ")}]`);
  const descIdx = lower.indexOf("description");
  return t.rows.map((row) => {
    const footnotes: string[] = [];
    const cell = (i: number): string => {
      const { text: s, marks } = splitFootnote(row[i] ?? "");
      footnotes.push(...marks);
      return s;
    };
    let name = cell(0);
    const optional = name.endsWith("?");
    if (optional) name = name.slice(0, -1);
    let type = cell(typeIdx);
    const nullable = type.startsWith("?");
    if (nullable) type = type.slice(1).trim();
    const description = descIdx >= 0 ? cell(descIdx) : "";
    return { name, optional, type, nullable, description, footnotes };
  });
}

/**
 * Pull endpoints, objects (with fields) and enums out of one page's section units.
 * `sections` are the page's sections from `splitSections`; unit i is section `ord` i. A bad table adds a
 * problem and is skipped; this never throws for table content.
 */
export function extractEntities(units: SectionUnit[], sections: ParsedSection[]): ExtractedEntities {
  const out: ExtractedEntities = { endpoints: [], objects: [], enums: [], problems: [] };

  // The part of unit `ord` whose markdown holds `node`, matched on its first serialized line.
  const sectionIdFor = (ord: number, node: MdNode): string => {
    const parts = sections.filter((s) => s.ord === ord);
    if (parts.length === 0) return "";
    const full = md(node).trimEnd();
    let hit = parts.find((p) => p.markdown.includes(full));
    if (!hit) {
      // table cut across parts: the part holding its header, separator and first data row
      const head = full.split("\n").slice(0, 3).join("\n");
      hit = parts.find((p) => p.markdown.includes(head));
    }
    return (hit ?? parts[0]).id;
  };

  units.forEach((u, ord) => {
    const unitName = u.heading ? text(u.heading) : "";
    const objMatch = u.level === 3 ? /^(.+) Object$/.exec(unitName) : null;
    const owner = objMatch ? objMatch[1] : null;
    let heading = unitName;
    let lastEndpoint: ParsedEndpoint | null = null;
    let objectDone = false;

    // A <Route> becomes a paragraph holding only an inline code `METHOD /path`; the same code inside prose is not one.
    const routeOf = (n: MdNode): RegExpExecArray | null =>
      n.type === "paragraph" && n.children.length === 1 && n.children[0].type === "inlineCode" ? ROUTE.exec(String(n.children[0].value).trim()) : null;

    for (const n of u.body) {
      if (n.type === "heading" && n.depth >= 4) {
        heading = text(n);
        continue;
      }
      if (n.type !== "table") {
        const m = routeOf(n);
        if (m) {
          lastEndpoint = {
            name: unitName,
            method: m[1],
            pathTemplate: m[2],
            normalizedPath: normalizePath(m[2]),
            sectionId: sectionIdFor(ord, n),
            params: [],
          };
          out.endpoints.push(lastEndpoint);
        }
        continue;
      }
      try {
        const sectionId = sectionIdFor(ord, n);
        const table = readTable(n);
        if (owner && !objectDone && heading === `${owner} Structure`) {
          out.objects.push({ name: owner, sectionId, fields: parseFields(table) });
          objectDone = true;
        } else if (STRUCT.test(heading) && looksLikeFields(table)) {
          // Structure tables outside an "X Object" section (e.g. component reference pages) are objects too.
          out.objects.push({ name: STRUCT.exec(heading)![1], sectionId, fields: parseFields(table) });
        } else if (lastEndpoint && /Params/.test(heading)) {
          (lastEndpoint as ParsedEndpoint).params.push({ name: heading, columns: table.columns, rows: table.rows } satisfies ParamTable);
        } else {
          out.enums.push({ name: heading, sectionId, ownerObject: owner, columns: table.columns, rows: table.rows });
        }
      } catch (e) {
        out.problems.push(`table under "${heading}" (section ${unitName || "intro"}): ${(e as Error).message}`);
      }
    }
  });
  return out;
}
