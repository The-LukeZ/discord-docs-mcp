import type { ParamTable, ParsedField } from "../parse/types";

/**
 * Read side of the snapshot store. Every function except `getSnapshotInfo` and `listChangeRecords` takes the
 * snapshot id to read from; only `getSnapshotInfo` looks at `refresh_state`, so a request resolves the current
 * snapshot once and reads a consistent view even while a refresh publishes.
 */

export interface SnapshotInfo {
  id: number;
  commitSha: string;
  /** when the index was last confirmed current (last successful refresh), ISO 8601 */
  indexedAt: string;
  /** true when the last successful refresh is older than `staleAfterHours` */
  stale: boolean;
}

export interface SectionRow {
  id: string;
  baseId: string;
  pagePath: string;
  area: string;
  anchor: string;
  heading: string;
  headingPath: string[];
  level: number;
  part: number;
  ord: number;
  markdown: string;
  contentHash: string;
}

export interface PageRow {
  path: string;
  title: string;
  sidebarTitle: string | null;
  description: string | null;
  breadcrumb: string[];
  url: string;
  blobSha: string | null;
  snippetDeps: string[];
  problems: string[];
}

export interface EndpointRow {
  name: string;
  method: string;
  pathTemplate: string;
  normalizedPath: string;
  sectionId: string;
  params: ParamTable[];
}

export interface ObjectRow {
  name: string;
  sectionId: string;
  fields: ParsedField[];
}

export interface EnumRow {
  name: string;
  sectionId: string;
  ownerObject: string | null;
  columns: string[];
  rows: string[][];
}

export interface ChangelogRow {
  id: string;
  date: string;
  tags: string[];
  title: string;
  description: string;
  markdown: string;
  links: string[];
  url: string;
}

export interface ChangeRecordRow {
  runId: string;
  commitSha: string;
  date: string;
  sectionId: string;
  heading: string;
  url: string;
  changeType: "added" | "modified" | "removed";
}

const json = <T>(s: unknown): T => JSON.parse(typeof s === "string" ? s : "[]") as T;
type Row = Record<string, any>;

export async function getSnapshotInfo(db: D1Database, now: Date, staleAfterHours: number): Promise<SnapshotInfo | null> {
  const r = await db
    .prepare(
      `SELECT s.id AS id, s.commit_sha AS commit_sha, s.created_at AS created_at, rs.last_success_at AS last_success_at
       FROM refresh_state rs JOIN snapshots s ON s.id = rs.current_snapshot
       WHERE rs.id = 1`,
    )
    .first<Row>();
  if (!r) return null;
  const indexedAt: string = r.last_success_at ?? r.created_at ?? "";
  const t = Date.parse(indexedAt);
  return {
    id: r.id,
    commitSha: r.commit_sha,
    indexedAt,
    stale: Number.isNaN(t) || now.getTime() - t > staleAfterHours * 3600_000,
  };
}

/** SQL condition: `col` is the id of a section of this snapshot in `area` (`areaParam` is the bound area, e.g. `?3`). */
const inArea = (col: string, areaParam: string): string =>
  `${col} IN (SELECT id FROM sections WHERE snapshot_id = ?1 AND area = ${areaParam})`;

const SECTION_COLS = "id, base_id, page_path, area, anchor, heading, heading_path, level, part, ord, markdown, content_hash";
const toSection = (r: Row): SectionRow => ({
  id: r.id,
  baseId: r.base_id,
  pagePath: r.page_path,
  area: r.area,
  anchor: r.anchor,
  heading: r.heading,
  headingPath: json<string[]>(r.heading_path),
  level: r.level,
  part: r.part,
  ord: r.ord,
  markdown: r.markdown,
  contentHash: r.content_hash,
});

/** All parts of one section, in part order. */
export async function getSectionsByBaseId(db: D1Database, snapshotId: number, baseId: string): Promise<SectionRow[]> {
  const res = await db
    .prepare(`SELECT ${SECTION_COLS} FROM sections WHERE snapshot_id = ?1 AND base_id = ?2 ORDER BY part`)
    .bind(snapshotId, baseId)
    .all<Row>();
  return res.results.map(toSection);
}

/** Every section part of a page, in page order. */
export async function getPageSections(db: D1Database, snapshotId: number, pagePath: string): Promise<SectionRow[]> {
  const res = await db
    .prepare(`SELECT ${SECTION_COLS} FROM sections WHERE snapshot_id = ?1 AND page_path = ?2 ORDER BY ord, part`)
    .bind(snapshotId, pagePath)
    .all<Row>();
  return res.results.map(toSection);
}

export async function getPage(db: D1Database, snapshotId: number, pagePath: string): Promise<PageRow | null> {
  const r = await db
    .prepare(
      "SELECT path, title, sidebar_title, description, breadcrumb, url, blob_sha, snippet_deps, problems FROM pages WHERE snapshot_id = ?1 AND path = ?2",
    )
    .bind(snapshotId, pagePath)
    .first<Row>();
  if (!r) return null;
  return {
    path: r.path,
    title: r.title,
    sidebarTitle: r.sidebar_title,
    description: r.description,
    breadcrumb: json<string[]>(r.breadcrumb),
    url: r.url,
    blobSha: r.blob_sha,
    snippetDeps: json<string[]>(r.snippet_deps),
    problems: json<string[]>(r.problems),
  };
}

/** Follow redirects (at most 5 hops, cycle-safe); returns `path` itself when there is none. */
export async function resolveRedirect(db: D1Database, snapshotId: number, path: string): Promise<string> {
  let current = path;
  const seen = new Set([current]);
  for (let hop = 0; hop < 5; hop++) {
    const r = await db
      .prepare("SELECT destination FROM redirects WHERE snapshot_id = ?1 AND source = ?2 LIMIT 1")
      .bind(snapshotId, current)
      .first<{ destination: string }>();
    if (!r || seen.has(r.destination)) return current;
    current = r.destination;
    seen.add(current);
  }
  return current;
}

/**
 * Section id that a `#anchor` on a page lands in: the section's own anchor, or an H4-H6 / stray manual anchor
 * inside it. Null when the page has no such anchor.
 */
export async function resolveAnchor(db: D1Database, snapshotId: number, pagePath: string, anchor: string): Promise<string | null> {
  const r = await db
    .prepare("SELECT section_id FROM section_anchors WHERE snapshot_id = ?1 AND page_path = ?2 AND anchor = ?3 LIMIT 1")
    .bind(snapshotId, pagePath, anchor)
    .first<{ section_id: string }>();
  return r?.section_id ?? null;
}

export async function findEndpoints(
  db: D1Database,
  snapshotId: number,
  q: { name?: string; method?: string; normalizedPath?: string; area?: string; limit?: number },
): Promise<EndpointRow[]> {
  const where = ["snapshot_id = ?1"];
  const bind: unknown[] = [snapshotId];
  const add = (cond: string, v: unknown) => {
    bind.push(v);
    where.push(cond.replace("?", `?${bind.length}`));
  };
  if (q.name !== undefined) add("lower(name) = lower(?)", q.name);
  if (q.method !== undefined) add("upper(method) = upper(?)", q.method);
  if (q.normalizedPath !== undefined) add("normalized_path = ?", q.normalizedPath);
  if (q.area !== undefined) {
    bind.push(q.area);
    where.push(inArea("section_id", `?${bind.length}`));
  }
  bind.push(q.limit ?? 50);
  const res = await db
    .prepare(
      `SELECT name, method, path_template, normalized_path, section_id, params FROM endpoints
       WHERE ${where.join(" AND ")} ORDER BY rowid LIMIT ?${bind.length}`,
    )
    .bind(...bind)
    .all<Row>();
  return res.results.map((r) => ({
    name: r.name,
    method: r.method,
    pathTemplate: r.path_template,
    normalizedPath: r.normalized_path,
    sectionId: r.section_id,
    params: json<ParamTable[]>(r.params),
  }));
}

/** Case-insensitive object lookup; first match in page order. */
export async function findObject(db: D1Database, snapshotId: number, name: string, area?: string): Promise<ObjectRow | null> {
  const r = await db
    .prepare(
      `SELECT name, section_id, fields FROM objects
       WHERE snapshot_id = ?1 AND lower(name) = lower(?2)${area !== undefined ? ` AND ${inArea("section_id", "?3")}` : ""}
       ORDER BY rowid LIMIT 1`,
    )
    .bind(...(area !== undefined ? [snapshotId, name, area] : [snapshotId, name]))
    .first<Row>();
  return r ? { name: r.name, sectionId: r.section_id, fields: json<ParsedField[]>(r.fields) } : null;
}

/** Enums by name and/or by a key (row name) they contain, case-insensitive. No criteria gives no result. */
export async function findEnums(db: D1Database, snapshotId: number, q: { name?: string; key?: string; area?: string; limit?: number }): Promise<EnumRow[]> {
  const any: string[] = [];
  const bind: unknown[] = [snapshotId];
  if (q.name !== undefined) {
    bind.push(q.name);
    any.push(`lower(e.name) = lower(?${bind.length})`);
  }
  if (q.key !== undefined) {
    bind.push(q.key);
    any.push(
      `EXISTS (SELECT 1 FROM enum_keys k WHERE k.snapshot_id = e.snapshot_id AND k.enum_name = e.name AND k.section_id IS e.section_id AND lower(k.key) = lower(?${bind.length}))`,
    );
  }
  if (any.length === 0) return [];
  let areaCond = "";
  if (q.area !== undefined) {
    bind.push(q.area);
    areaCond = ` AND ${inArea("e.section_id", `?${bind.length}`)}`;
  }
  bind.push(q.limit ?? 50);
  const res = await db
    .prepare(
      `SELECT e.name, e.section_id, e.owner_object, e.columns, e.rows FROM enums e
       WHERE e.snapshot_id = ?1 AND (${any.join(" OR ")})${areaCond} ORDER BY e.rowid LIMIT ?${bind.length}`,
    )
    .bind(...bind)
    .all<Row>();
  return res.results.map((r) => ({
    name: r.name,
    sectionId: r.section_id,
    ownerObject: r.owner_object,
    columns: json<string[]>(r.columns),
    rows: json<string[][]>(r.rows),
  }));
}

/** Changelog entries dated `since` (YYYY-MM-DD) or later, newest first (same day: page order). */
export async function listChangelog(db: D1Database, snapshotId: number, since: string, limit: number): Promise<ChangelogRow[]> {
  const res = await db
    .prepare(
      `SELECT id, date, tags, title, description, markdown, links, url FROM changelog_entries
       WHERE snapshot_id = ?1 AND date >= ?2 ORDER BY date DESC, rowid LIMIT ?3`,
    )
    .bind(snapshotId, since, limit)
    .all<Row>();
  return res.results.map((r) => ({
    id: r.id,
    date: r.date,
    tags: json<string[]>(r.tags),
    title: r.title,
    description: r.description,
    markdown: r.markdown,
    links: json<string[]>(r.links),
    url: r.url,
  }));
}

/** Documentation change records dated `since` or later, newest first. Records belong to runs, not snapshots. */
export async function listChangeRecords(db: D1Database, since: string, limit: number): Promise<ChangeRecordRow[]> {
  const res = await db
    .prepare(
      `SELECT run_id, commit_sha, date, section_id, heading, url, change_type FROM change_records
       WHERE date >= ?1 ORDER BY date DESC, rowid LIMIT ?2`,
    )
    .bind(since, limit)
    .all<Row>();
  return res.results.map((r) => ({
    runId: r.run_id,
    commitSha: r.commit_sha,
    date: r.date,
    sectionId: r.section_id,
    heading: r.heading,
    url: r.url,
    changeType: r.change_type,
  }));
}

export async function counts(
  db: D1Database,
  snapshotId: number,
): Promise<{ pages: number; sections: number; endpoints: number; objects: number; enums: number; changelog: number }> {
  const r = await db
    .prepare(
      `SELECT
         (SELECT count(*) FROM pages WHERE snapshot_id = ?1) AS pages,
         (SELECT count(*) FROM sections WHERE snapshot_id = ?1) AS sections,
         (SELECT count(*) FROM endpoints WHERE snapshot_id = ?1) AS endpoints,
         (SELECT count(*) FROM objects WHERE snapshot_id = ?1) AS objects,
         (SELECT count(*) FROM enums WHERE snapshot_id = ?1) AS enums,
         (SELECT count(*) FROM changelog_entries WHERE snapshot_id = ?1) AS changelog`,
    )
    .bind(snapshotId)
    .first<Row>();
  return {
    pages: r!.pages,
    sections: r!.sections,
    endpoints: r!.endpoints,
    objects: r!.objects,
    enums: r!.enums,
    changelog: r!.changelog,
  };
}

/** Section ids of the objects that have a field called `name` (case-insensitive), in page order; optionally only in `area`. */
export async function findFieldSectionIds(db: D1Database, snapshotId: number, name: string, limit = 20, area?: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT section_id FROM fields WHERE snapshot_id = ?1 AND lower(name) = lower(?2) AND section_id IS NOT NULL${
        area !== undefined ? ` AND ${inArea("section_id", "?4")}` : ""
      }
       ORDER BY rowid LIMIT ?3`,
    )
    .bind(...(area !== undefined ? [snapshotId, name, limit, area] : [snapshotId, name, limit]))
    .all<{ section_id: string }>();
  return res.results.map((r) => r.section_id);
}

/** Section ids of the enums that have a row key `key` (case-insensitive); optionally only in `area`. */
export async function findEnumKeySectionIds(db: D1Database, snapshotId: number, key: string, limit = 20, area?: string): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT section_id FROM enum_keys WHERE snapshot_id = ?1 AND lower(key) = lower(?2) AND section_id IS NOT NULL${
        area !== undefined ? ` AND ${inArea("section_id", "?4")}` : ""
      }
       ORDER BY rowid LIMIT ?3`,
    )
    .bind(...(area !== undefined ? [snapshotId, key, limit, area] : [snapshotId, key, limit]))
    .all<{ section_id: string }>();
  return res.results.map((r) => r.section_id);
}

export interface SectionSummary {
  id: string;
  baseId: string;
  area: string;
  anchor: string;
  headingPath: string[];
  markdown: string;
  pageTitle: string;
  /** public url of the section: page url plus `#anchor` (none for a page intro) */
  url: string;
}

/** Sections by id (part ids included) joined with their page, keyed by section id. Unknown ids are absent. */
export async function getSectionSummaries(db: D1Database, snapshotId: number, ids: string[]): Promise<Map<string, SectionSummary>> {
  const out = new Map<string, SectionSummary>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const part = unique.slice(i, i + 50);
    const marks = part.map((_, k) => `?${k + 2}`).join(", ");
    const res = await db
      .prepare(
        `SELECT s.id AS id, s.base_id AS base_id, s.area AS area, s.anchor AS anchor, s.heading_path AS heading_path,
                s.markdown AS markdown, p.title AS title, p.url AS url
         FROM sections s JOIN pages p ON p.snapshot_id = s.snapshot_id AND p.path = s.page_path
         WHERE s.snapshot_id = ?1 AND s.id IN (${marks})`,
      )
      .bind(snapshotId, ...part)
      .all<Row>();
    for (const r of res.results)
      out.set(r.id, {
        id: r.id,
        baseId: r.base_id,
        area: r.area,
        anchor: r.anchor,
        headingPath: json<string[]>(r.heading_path),
        markdown: r.markdown ?? "",
        pageTitle: r.title ?? "",
        url: r.anchor ? `${r.url}#${r.anchor}` : r.url,
      });
  }
  return out;
}

/** Every object with this name (case-insensitive), in page order. */
export async function findObjects(db: D1Database, snapshotId: number, name: string, limit = 10): Promise<ObjectRow[]> {
  const res = await db
    .prepare("SELECT name, section_id, fields FROM objects WHERE snapshot_id = ?1 AND lower(name) = lower(?2) ORDER BY rowid LIMIT ?3")
    .bind(snapshotId, name, limit)
    .all<Row>();
  return res.results.map((r) => ({ name: r.name, sectionId: r.section_id, fields: json<ParsedField[]>(r.fields) }));
}

/** Name and section id of every object, in page order (for fuzzy name matching). */
export async function listObjectNames(db: D1Database, snapshotId: number): Promise<Array<{ name: string; sectionId: string }>> {
  const res = await db.prepare("SELECT name, section_id FROM objects WHERE snapshot_id = ?1 ORDER BY rowid").bind(snapshotId).all<Row>();
  return res.results.map((r) => ({ name: r.name, sectionId: r.section_id }));
}

/** Name and section id of every enum table, in page order (for fuzzy name matching). */
export async function listEnumNames(db: D1Database, snapshotId: number): Promise<Array<{ name: string; sectionId: string }>> {
  const res = await db.prepare("SELECT name, section_id FROM enums WHERE snapshot_id = ?1 ORDER BY rowid").bind(snapshotId).all<Row>();
  return res.results.map((r) => ({ name: r.name, sectionId: r.section_id }));
}

/** Enums owned by the object `objectName` or whose name starts with it ("Channel Flags" for "Channel"), page order. */
export async function findRelatedEnums(db: D1Database, snapshotId: number, objectName: string, limit = 30): Promise<EnumRow[]> {
  const res = await db
    .prepare(
      `SELECT name, section_id, owner_object, columns, rows FROM enums
       WHERE snapshot_id = ?1 AND (lower(owner_object) = lower(?2) OR substr(lower(name), 1, length(?2) + 1) = lower(?2) || ' ')
       ORDER BY rowid LIMIT ?3`,
    )
    .bind(snapshotId, objectName, limit)
    .all<Row>();
  return res.results.map((r) => ({
    name: r.name,
    sectionId: r.section_id,
    ownerObject: r.owner_object,
    columns: json<string[]>(r.columns),
    rows: json<string[][]>(r.rows),
  }));
}

/** Endpoints whose owning section has one of these base ids (part suffixes of the stored id are ignored). */
export async function getEndpointsBySectionIds(db: D1Database, snapshotId: number, baseIds: string[]): Promise<EndpointRow[]> {
  const out: EndpointRow[] = [];
  const unique = [...new Set(baseIds)];
  for (let i = 0; i < unique.length; i += 50) {
    const part = unique.slice(i, i + 50);
    const marks = part.map((_, k) => `?${k + 2}`).join(", ");
    const res = await db
      .prepare(
        `SELECT name, method, path_template, normalized_path, section_id, params FROM endpoints
         WHERE snapshot_id = ?1 AND (CASE WHEN instr(section_id, '~') > 0 THEN substr(section_id, 1, instr(section_id, '~') - 1) ELSE section_id END) IN (${marks})
         ORDER BY rowid`,
      )
      .bind(snapshotId, ...part)
      .all<Row>();
    for (const r of res.results)
      out.push({
        name: r.name,
        method: r.method,
        pathTemplate: r.path_template,
        normalizedPath: r.normalized_path,
        sectionId: r.section_id,
        params: json<ParamTable[]>(r.params),
      });
  }
  return out;
}
