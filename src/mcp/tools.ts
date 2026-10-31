import type { Config } from "../config";
import { parseEndpointQuery, toFtsQuery } from "../search/query";
import { searchDocs } from "../search/search";
import {
  findEndpoints,
  findEnums,
  findObjects,
  findRelatedEnums,
  getEndpointsBySectionIds,
  getPage,
  getPageSections,
  getSectionsByBaseId,
  getSectionSummaries,
  getSnapshotInfo,
  listChangelog,
  listChangeRecords,
  listEnumNames,
  listObjectNames,
  resolveAnchor,
  resolveRedirect,
  type EndpointRow,
  type SectionRow,
  type SnapshotInfo,
} from "../store/read";
import { baseId, decodeCursor, docsUrl, encodeCursor, envelope, mdTable, oneLine, truncate, type Cursor, type ToolResult } from "./format";

export type { ToolResult } from "./format";

/**
 * The six tool functions. They take the database, the config and the tool input only (never a Request or headers)
 * and return plain text. Every response, errors included, carries the index envelope once an index exists.
 */

const BUILDING = "The documentation index is being built. Try again in a few minutes.";
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_CHANGES_LIMIT = 20;
const MAX_CHANGES_LIMIT = 100;
const CHANGES_DEFAULT_DAYS = 30;
const MAX_EXPANDED = 3;
const MAX_NEAR = 5;
const MAX_SUGGESTIONS = 5;

const ok = (text: string): ToolResult => ({ text, isError: false });
const fail = (text: string): ToolResult => ({ text, isError: true });
const invalid = (msg: string): ToolResult => fail(`Invalid input: ${msg}`);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const clamp = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), min), max) : def;

/** Resolve the current snapshot once, run the tool against it and wrap the result in the envelope. */
async function run(db: D1Database, cfg: Config, fn: (info: SnapshotInfo) => Promise<ToolResult>): Promise<ToolResult> {
  const info = await getSnapshotInfo(db, new Date(), cfg.staleAfterHours);
  if (!info) return fail(BUILDING);
  const r = await fn(info);
  return { text: envelope(r.text, info), isError: r.isError };
}

/** `Not found: <what>` plus up to 5 search suggestions for `queryText`. */
async function notFound(db: D1Database, info: SnapshotInfo, what: string, queryText: string): Promise<ToolResult> {
  const hits = await searchDocs(db, info.id, { query: queryText, limit: MAX_SUGGESTIONS });
  const list = hits.map((h) => `- ${h.headingPath.join(" > ")} (section_id: ${h.sectionId}) ${h.url}`);
  return fail(`Not found: ${what}${list.length > 0 ? `\n\nDid you mean:\n${list.join("\n")}` : ""}`);
}

/** Cut a lookup response at the cap (lookups have no cursor); points at get_section for the rest. */
function capBody(cfg: Config, text: string, hint: string): string {
  const { slice, nextOffset } = truncate(text, 0, cfg.responseCharCap);
  return nextOffset === null ? text : `${slice}\n\n[Truncated at ${slice.length} of ${text.length} characters. Use get_section with ${hint} for the full text.]`;
}

// ---------------------------------------------------------------- search_docs

export async function searchDocsTool(db: D1Database, cfg: Config, input: { query: string; limit?: number; area?: string }): Promise<ToolResult> {
  return run(db, cfg, async (info) => {
    const query = str(input?.query);
    if (query === "" || toFtsQuery(query, "and") === null) return invalid("query must contain at least one letter or digit.");
    const limit = clamp(input.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
    const area = str(input.area) || undefined;
    const hits = await searchDocs(db, info.id, { query, limit, area });
    if (hits.length === 0) return ok(`No results for "${oneLine(query, 120)}"${area ? ` in area "${oneLine(area, 60)}"` : ""}. Try different words or a broader query.`);
    const lines = hits.map(
      (h, i) => `${i + 1}. **${h.headingPath.join(" > ")}** (${h.pageTitle})\n   section_id: ${h.sectionId}\n   URL: ${h.url}\n   ${oneLine(h.snippet, 300)}`,
    );
    return ok(`Search results for "${oneLine(query, 120)}" (${hits.length}):\n\n${lines.join("\n\n")}`);
  });
}

// ---------------------------------------------------------------- get_section

interface SectionRef {
  page: string;
  anchor: string;
  part: number | null;
  legacy: boolean;
}

/** `https://docs.discord.com/developers/<path>[#a]` or legacy `https://discord.com/developers/docs/<path>[#a]`. */
function parseUrl(raw: string): SectionRef | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let rest: string;
  let legacy = false;
  if (host === "docs.discord.com" && /^\/developers(\/|$)/.test(u.pathname)) rest = u.pathname.slice("/developers".length);
  else if ((host === "discord.com" || host === "www.discord.com") && /^\/developers\/docs(\/|$)/.test(u.pathname)) {
    rest = u.pathname.slice("/developers/docs".length);
    legacy = true;
  } else return null;
  let anchor = u.hash.replace(/^#/, "");
  try {
    anchor = decodeURIComponent(anchor);
  } catch {
    /* keep the raw anchor */
  }
  return { page: rest.replace(/^\/+|\/+$/g, ""), anchor, part: null, legacy };
}

/** `path[#anchor][~n]` as shown in search results. */
function parseSectionId(raw: string): SectionRef | null {
  let s = raw.replace(/^\/+/, "");
  let part: number | null = null;
  const m = /~(\d+)$/.exec(s);
  if (m) {
    part = Number(m[1]);
    s = s.slice(0, m.index);
  }
  const hash = s.indexOf("#");
  const page = hash < 0 ? s : s.slice(0, hash);
  if (page === "") return null;
  return { page, anchor: hash < 0 ? "" : s.slice(hash + 1), part, legacy: false };
}

/** The stored page for a path, following docs.json redirects (stored by page path; legacy sources keep a `docs/` prefix). */
async function resolvePage(db: D1Database, snapshotId: number, ref: SectionRef): Promise<string | null> {
  if (ref.page !== "" && (await getPage(db, snapshotId, ref.page))) return ref.page;
  const lower = ref.page.toLowerCase();
  for (const source of ref.legacy ? [`docs/${lower}`, lower] : [lower, `docs/${lower}`]) {
    const dest = await resolveRedirect(db, snapshotId, source);
    if (dest !== source && dest !== "" && (await getPage(db, snapshotId, dest))) return dest;
  }
  return null;
}

/** Parts of one section as one markdown text: the heading line repeated at the top of each part is dropped. */
function joinParts(rows: SectionRow[]): string {
  const heading = rows[0].markdown.split("\n")[0];
  return rows.map((r, i) => (i > 0 && r.markdown.startsWith(`${heading}\n\n`) ? r.markdown.slice(heading.length + 2) : r.markdown)).join("\n\n");
}

function paginate(cfg: Config, header: string, content: string, target: string, cursor: Cursor | null): ToolResult {
  let offset = 0;
  if (cursor) {
    if (cursor.target !== target) return invalid(`this cursor was issued for a different section ("${oneLine(cursor.target, 100)}"). Repeat the request without a cursor, or use the cursor with its own section_id or url.`);
    if (cursor.offset >= content.length) return invalid("the cursor points past the end of this section. Repeat the request without a cursor.");
    offset = cursor.offset;
  }
  const { slice, nextOffset } = truncate(content, offset, cfg.responseCharCap);
  let text = `${header}\n${slice}`;
  if (nextOffset !== null) {
    text += `\n\n[Truncated: showing characters ${offset}-${offset + slice.length} of ${content.length}. Call get_section again with the same section_id or url and the cursor below to continue.]\ncursor: ${encodeCursor({ target, offset: nextOffset })}`;
  }
  return ok(text);
}

async function pageOutline(db: D1Database, cfg: Config, info: SnapshotInfo, pagePath: string, cursor: Cursor | null): Promise<ToolResult> {
  const [page, rows] = await Promise.all([getPage(db, info.id, pagePath), getPageSections(db, info.id, pagePath)]);
  if (!page || rows.length === 0) return notFound(db, info, `page "${pagePath}" has no indexed content.`, pagePath.replace(/[/-]+/g, " "));
  const byBase = new Map<string, SectionRow[]>();
  for (const r of rows) byBase.set(r.baseId, [...(byBase.get(r.baseId) ?? []), r]);
  const outline = [...byBase].map(([id, parts]) => `${"  ".repeat(Math.max(0, parts[0].level - 2))}- ${parts[0].heading} (section_id: ${id})`);
  const body = [...byBase.values()].map(joinParts).join("\n\n");
  const content = `Outline (every section_id on this page):\n${outline.join("\n")}\n\n---\n\n${body}`;
  const header = `# ${page.title}\nURL: ${docsUrl(pagePath)}\npage: ${pagePath}\n`;
  return paginate(cfg, header, content, `page:${pagePath}`, cursor);
}

export async function getSectionTool(db: D1Database, cfg: Config, input: { section_id?: string; url?: string; cursor?: string }): Promise<ToolResult> {
  return run(db, cfg, async (info) => {
    const sectionId = str(input?.section_id);
    const url = str(input?.url);
    const given = sectionId || url;
    if (given === "") return invalid("provide section_id (from a search result) or url. A cursor alone is not enough: send it together with the same section_id or url.");
    const cursorText = str(input.cursor);
    const cursor = cursorText === "" ? null : decodeCursor(cursorText);
    if (cursorText !== "" && !cursor) return invalid("the cursor is not valid. Repeat the request without a cursor.");

    const asUrl = sectionId === "" || /^https?:\/\//i.test(sectionId);
    const ref = asUrl ? parseUrl(sectionId || url) : parseSectionId(sectionId);
    const queryText = given.replace(/^https?:\/\/[^/]+/i, "").replace(/[#/~-]+/g, " ");
    if (!ref) return notFound(db, info, `"${oneLine(given, 200)}" is not a docs.discord.com/developers URL or a section_id such as "resources/channel#channel-object".`, queryText);

    const pagePath = await resolvePage(db, info.id, ref);
    if (pagePath === null) return notFound(db, info, `no documentation page for "${oneLine(given, 200)}".`, queryText);
    if (ref.anchor === "") return pageOutline(db, cfg, info, pagePath, cursor);

    let rows = await getSectionsByBaseId(db, info.id, `${pagePath}#${ref.anchor}`);
    if (rows.length === 0) {
      const owner = await resolveAnchor(db, info.id, pagePath, ref.anchor);
      if (owner) rows = await getSectionsByBaseId(db, info.id, baseId(owner));
    }
    if (ref.part !== null) rows = rows.filter((r) => r.part === ref.part);
    if (rows.length === 0) return notFound(db, info, `no section "${oneLine(given, 200)}".`, queryText);

    const id = ref.part !== null ? rows[0].id : rows[0].baseId;
    const header = `# ${rows[0].headingPath.join(" > ")}\nURL: ${docsUrl(id)}\nsection_id: ${id}\n`;
    return paginate(cfg, header, joinParts(rows), id, cursor);
  });
}

// ---------------------------------------------------------------- lookup_endpoint

/** First plain paragraph of an endpoint section: not a heading, route line, table, code or tag. */
function describeSection(markdown: string): string {
  for (const block of markdown.split(/\n{2,}/)) {
    const b = block.trim();
    if (b === "" || /^(#|\||```|<)/.test(b) || /^`(GET|POST|PUT|PATCH|DELETE) /.test(b)) continue;
    return oneLine(b, 600);
  }
  return "";
}

export async function lookupEndpointTool(db: D1Database, cfg: Config, input: { query: string }): Promise<ToolResult> {
  return run(db, cfg, async (info) => {
    const query = str(input?.query);
    if (query === "") return invalid("query must be an endpoint name (\"Get Channel\"), a path, or \"METHOD /path\".");
    const pq = parseEndpointQuery(query);
    // Always a real criterion: findEndpoints without one lists up to 50 endpoints.
    const exact = await findEndpoints(
      db,
      info.id,
      pq.path !== undefined ? { method: pq.method, normalizedPath: pq.path, limit: 10 } : { name: pq.name ?? query, limit: 10 },
    );

    // For a path query, search by the path: the HTTP method word would match every endpoint.
    const searchText = pq.path ?? query;
    const hits = await searchDocs(db, info.id, { query: searchText, limit: MAX_SEARCH_LIMIT });
    const owned = await getEndpointsBySectionIds(db, info.id, hits.map((h) => h.sectionId));
    const key = (e: EndpointRow) => `${e.sectionId} ${e.method} ${e.pathTemplate}`;
    const seen = new Set(exact.map(key));
    const near: EndpointRow[] = [];
    for (const h of hits) {
      for (const e of owned) {
        if (near.length >= MAX_NEAR || baseId(e.sectionId) !== h.sectionId || seen.has(key(e))) continue;
        near.push(e);
        seen.add(key(e));
      }
    }

    if (exact.length === 0 && near.length === 0) return notFound(db, info, `no endpoint matches "${oneLine(query, 200)}".`, searchText);

    const sums = await getSectionSummaries(db, info.id, exact.map((e) => e.sectionId));
    const parts: string[] = [
      exact.length > 0
        ? `Endpoint matches for "${oneLine(query, 120)}" (${exact.length}):`
        : `No exact endpoint match for "${oneLine(query, 120)}". Near matches below.`,
    ];
    for (const e of exact) {
      const desc = describeSection(sums.get(e.sectionId)?.markdown ?? "");
      const tables = e.params.map((p) => `### ${p.name}\n${mdTable(p.columns, p.rows)}`);
      parts.push(
        [`## ${e.name}`, `\`${e.method} ${e.pathTemplate}\``, `URL: ${docsUrl(e.sectionId)}`, `section_id: ${baseId(e.sectionId)}`, ...(desc ? ["", desc] : []), ...(tables.length ? ["", tables.join("\n\n")] : [])].join("\n"),
      );
    }
    if (near.length > 0) {
      parts.push(`## Near matches\n${near.map((e) => `- **${e.name}** \`${e.method} ${e.pathTemplate}\` (section_id: ${baseId(e.sectionId)}) ${docsUrl(e.sectionId)}`).join("\n")}`);
    }
    return ok(capBody(cfg, parts.join("\n\n"), `section_id "${baseId(exact[0]?.sectionId ?? near[0].sectionId)}"`));
  });
}

// ---------------------------------------------------------------- lookup_object / lookup_enum

const SUFFIX = /\s+(object|structure)$/i;
const stripSuffix = (s: string): string => {
  const t = s.replace(SUFFIX, "").trim();
  return t === "" ? s : t;
};

/**
 * Name matching: case-insensitive exact, then with a trailing " Object"/" Structure" stripped, then the shortest
 * name containing every query token. The listing needed for the last step is only read when the cheap ones miss.
 */
async function resolveName<T>(
  query: string,
  find: (name: string) => Promise<T[]>,
  list: () => Promise<Array<{ name: string }>>,
): Promise<T[]> {
  for (const name of new Set([query, stripSuffix(query)])) {
    const rows = await find(name);
    if (rows.length > 0) return rows;
  }
  const tokens = stripSuffix(query).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return [];
  const best = (await list())
    .filter((n) => tokens.every((t) => n.name.toLowerCase().includes(t)))
    .sort((a, b) => a.name.length - b.name.length)[0];
  return best ? find(best.name) : [];
}

const matchedNote = (query: string, name: string): string => (name.toLowerCase() === query.toLowerCase() ? "" : `(Matched "${oneLine(query, 100)}" to "${name}".)\n\n`);

export async function lookupObjectTool(db: D1Database, cfg: Config, input: { name: string }): Promise<ToolResult> {
  return run(db, cfg, async (info) => {
    const query = str(input?.name);
    if (query === "") return invalid("name must be an object name such as \"Channel\" or \"Message Component\".");
    const rows = await resolveName(query, (n) => findObjects(db, info.id, n, 10), () => listObjectNames(db, info.id));
    if (rows.length === 0) return notFound(db, info, `no object named "${oneLine(query, 200)}".`, query);

    const parts: string[] = [];
    const listed = new Set<string>();
    for (const o of rows.slice(0, MAX_EXPANDED)) {
      const fields = o.fields.map((f) => {
        const flags = [f.optional ? "optional" : "", f.nullable ? "nullable" : ""].filter(Boolean).join(", ");
        const notes = f.footnotes.length > 0 ? ` [${f.footnotes.map((n) => oneLine(n, 200)).join("; ")}]` : "";
        return `- \`${f.name}\` (${f.type}${flags ? `; ${flags}` : ""})${f.description ? `: ${oneLine(f.description, 400)}` : ""}${notes}`;
      });
      const enums = (await findRelatedEnums(db, info.id, o.name)).filter((e) => {
        const k = `${e.name} ${baseId(e.sectionId)}`;
        return !listed.has(k) && listed.add(k);
      });
      parts.push(
        [
          `## ${o.name} (object)`,
          `URL: ${docsUrl(o.sectionId)}`,
          `section_id: ${baseId(o.sectionId)}`,
          "",
          fields.length > 0 ? `### Fields\n${fields.join("\n")}` : "No field table was parsed; use get_section for the full text.",
          ...(enums.length > 0 ? ["", `### Related enums and flags\n${enums.map((e) => `- ${e.name} (section_id: ${baseId(e.sectionId)}) ${docsUrl(e.sectionId)}`).join("\n")}`] : []),
        ].join("\n"),
      );
    }
    if (rows.length > MAX_EXPANDED) {
      parts.push(`Other objects with this name:\n${rows.slice(MAX_EXPANDED).map((o) => `- ${o.name} (section_id: ${baseId(o.sectionId)}) ${docsUrl(o.sectionId)}`).join("\n")}`);
    }
    return ok(capBody(cfg, matchedNote(query, rows[0].name) + parts.join("\n\n"), `section_id "${baseId(rows[0].sectionId)}"`));
  });
}

export async function lookupEnumTool(db: D1Database, cfg: Config, input: { name: string }): Promise<ToolResult> {
  return run(db, cfg, async (info) => {
    const query = str(input?.name);
    if (query === "") return invalid("name must be an enum or flags table name such as \"Channel Types\" or \"Permission Flags\".");
    let rows = await resolveName(query, (n) => findEnums(db, info.id, { name: n, limit: 10 }), () => listEnumNames(db, info.id));
    let note = rows.length > 0 ? matchedNote(query, rows[0].name) : "";
    if (rows.length === 0) {
      rows = await findEnums(db, info.id, { key: query, limit: 10 });
      if (rows.length > 0) note = `No enum is named "${oneLine(query, 100)}"; showing the enums that contain that key.\n\n`;
    }
    if (rows.length === 0) return notFound(db, info, `no enum or flags table named "${oneLine(query, 200)}".`, query);

    const parts = rows.slice(0, 5).map((e) =>
      [`## ${e.name}`, `Owning object: ${e.ownerObject ?? "none"}`, `URL: ${docsUrl(e.sectionId)}`, `section_id: ${baseId(e.sectionId)}`, "", mdTable(e.columns, e.rows)].join("\n"),
    );
    if (rows.length > 5) parts.push(`More tables:\n${rows.slice(5).map((e) => `- ${e.name} (section_id: ${baseId(e.sectionId)}) ${docsUrl(e.sectionId)}`).join("\n")}`);
    return ok(capBody(cfg, note + parts.join("\n\n"), `section_id "${baseId(rows[0].sectionId)}"`));
  });
}

// ---------------------------------------------------------------- recent_changes

/** A `since` date (YYYY-MM-DD, or a full ISO timestamp) as YYYY-MM-DD; null when it is not a real date. */
function parseSince(v: string): string | null {
  const day = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(v)?.[1];
  if (!day) return null;
  const t = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== day ? null : day;
}

export async function recentChangesTool(db: D1Database, cfg: Config, input: { since?: string; source?: "changelog" | "docs" | "both"; limit?: number }): Promise<ToolResult> {
  return run(db, cfg, async (info) => {
    const source = str(input?.source) || "both";
    if (source !== "changelog" && source !== "docs" && source !== "both") return invalid('source must be "changelog", "docs" or "both".');
    const sinceText = str(input.since);
    const since = sinceText === "" ? new Date(Date.now() - CHANGES_DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10) : parseSince(sinceText);
    if (since === null) return invalid("since must be a date such as 2026-10-01.");
    const limit = clamp(input.limit, DEFAULT_CHANGES_LIMIT, 1, MAX_CHANGES_LIMIT);

    const [entries, records] = await Promise.all([
      source === "docs" ? [] : listChangelog(db, info.id, since, limit),
      source === "changelog" ? [] : listChangeRecords(db, since, limit),
    ]);
    const merged = [
      ...entries.map((e) => ({ date: e.date.slice(0, 10), line: `- **${e.date.slice(0, 10)}**${e.tags.length ? ` [${e.tags.join(", ")}]` : ""} ${e.title}${e.description ? ` - ${oneLine(e.description, 300)}` : ""}\n  ${e.url}`, kind: "changelog" })),
      ...records.map((r) => ({ date: r.date.slice(0, 10), line: `- **${r.date.slice(0, 10)}** ${r.changeType}: ${r.heading} (section_id: ${r.sectionId})\n  ${r.url}`, kind: "docs" })),
    ]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, limit);

    if (merged.length === 0) return ok(`No changelog entries or documentation changes since ${since}.`);
    const section = (title: string, kind: string) => {
      const lines = merged.filter((m) => m.kind === kind).map((m) => m.line);
      return lines.length > 0 ? `## ${title}\n${lines.join("\n")}` : "";
    };
    const body = [section("Changelog", "changelog"), section("Documentation changes", "docs")].filter(Boolean).join("\n\n");
    return ok(capBody(cfg, `Changes since ${since} (newest first, up to ${limit}):\n\n${body}`, `a url from the list`));
  });
}
