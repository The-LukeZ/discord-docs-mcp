import { findEndpoints, findEnumKeySectionIds, findEnums, findFieldSectionIds, findObject, getSectionSummaries, type SectionSummary } from "../store/read";
import { parseEndpointQuery, toFtsQuery } from "./query";

export interface SearchHit {
  /** base id of the section (no `~part` suffix) */
  sectionId: string;
  headingPath: string[];
  pageTitle: string;
  url: string;
  snippet: string;
  matchedOn: "endpoint" | "object" | "field" | "enum" | "text";
}

export interface SearchInput {
  query: string;
  limit: number;
  area?: string;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/** Entity lookups are exact-name matches; a longer query cannot be a name. */
const MAX_NAME_CHARS = 120;
const SNIPPET_CHARS = 300;
/** FTS rows fetched per query: dedupe by base id and the area filter may drop some. */
const FTS_FETCH = 60;
/** bm25 column weights: snapshot_id, section_id, area (unindexed), heading_path, title, body. */
const BM25 = "bm25(sections_fts, 0, 0, 0, 10.0, 5.0, 1.0)";

function firstChars(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  // do not leave half a surrogate pair at the end
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Search one snapshot. Exact identifiers rank first: endpoint (method + path, path, or name), object name and
 * enum name; then field names and enum keys; then full-text (bm25, headings and page title weighted above
 * the body). Hits are deduped by section base id, keeping the best-ranked. Never throws on odd input: free text
 * only reaches SQL as bound parameters, and the FTS expression is rebuilt from sanitized tokens.
 */
export async function searchDocs(db: D1Database, snapshotId: number, input: SearchInput): Promise<SearchHit[]> {
  const limit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const area = input.area === undefined || input.area === "" ? undefined : input.area;
  const query = typeof input.query === "string" ? input.query : "";
  if (toFtsQuery(query, "and") === null) return [];

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const full = () => hits.length >= limit;

  const add = (s: SectionSummary, matchedOn: SearchHit["matchedOn"], snippet?: string): void => {
    if (full() || seen.has(s.baseId) || (area !== undefined && s.area !== area)) return;
    seen.add(s.baseId);
    hits.push({
      sectionId: s.baseId,
      headingPath: s.headingPath,
      pageTitle: s.pageTitle,
      url: s.url,
      snippet: snippet && snippet.trim() !== "" ? snippet : firstChars(s.markdown, SNIPPET_CHARS),
      matchedOn,
    });
  };
  const addIds = async (ids: string[], matchedOn: SearchHit["matchedOn"]): Promise<void> => {
    if (ids.length === 0 || full()) return;
    const sums = await getSectionSummaries(db, snapshotId, ids);
    for (const id of ids) {
      const s = sums.get(id);
      if (s) add(s, matchedOn);
    }
  };

  // Tier 0: exact endpoint, object, enum names.
  const ep = parseEndpointQuery(query);
  if (ep.name === undefined || ep.name.length <= MAX_NAME_CHARS) {
    if (ep.path !== undefined || ep.name !== undefined) {
      const rows = await findEndpoints(db, snapshotId, { name: ep.name, method: ep.method, normalizedPath: ep.path, limit: MAX_LIMIT });
      await addIds(rows.map((r) => r.sectionId), "endpoint");
    }
    if (ep.name !== undefined) {
      const obj = await findObject(db, snapshotId, ep.name);
      if (obj) await addIds([obj.sectionId], "object");
      const enums = await findEnums(db, snapshotId, { name: ep.name, limit: MAX_LIMIT });
      await addIds(enums.map((e) => e.sectionId), "enum");

      // Tier 1: field names and enum keys.
      await addIds(await findFieldSectionIds(db, snapshotId, ep.name, MAX_LIMIT), "field");
      await addIds(await findEnumKeySectionIds(db, snapshotId, ep.name, MAX_LIMIT), "enum");
    }
  }

  // Tier 2: full text. AND first, OR only when that left room.
  for (const mode of ["and", "or"] as const) {
    if (full()) break;
    const match = toFtsQuery(query, mode);
    if (match === null || (mode === "or" && match === toFtsQuery(query, "and"))) continue;
    const bind: unknown[] = [match, snapshotId];
    if (area !== undefined) bind.push(area);
    bind.push(FTS_FETCH);
    const res = await db
      .prepare(
        `SELECT section_id, snippet(sections_fts, 5, '', '', '...', 24) AS snip FROM sections_fts
         WHERE sections_fts MATCH ?1 AND snapshot_id = ?2${area !== undefined ? " AND area = ?3" : ""}
         ORDER BY ${BM25} LIMIT ?${bind.length}`,
      )
      .bind(...bind)
      .all<{ section_id: string; snip: string | null }>();
    const sums = await getSectionSummaries(db, snapshotId, res.results.map((r) => r.section_id));
    for (const r of res.results) {
      const s = sums.get(r.section_id);
      if (s) add(s, "text", r.snip ?? undefined);
    }
  }
  return hits;
}
