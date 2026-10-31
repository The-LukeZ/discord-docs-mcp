import type { ParsedPage } from "../parse/page";
import type { ParsedEnum } from "../parse/types";

/** D1 allows at most 50 statements per batch and 100 bound parameters per statement. */
const MAX_BATCH = 50;
/** Page paths per IN (...) list; with the snapshot id parameters this stays well under 100 bound parameters. */
const PATH_CHUNK = 45;
/** The one page whose entries live in `changelog_entries` (see parsePage). */
const CHANGELOG_PATH = "change-log";
/** A `building` snapshot older than this is considered abandoned and is removed by `cleanup`. */
const STALE_BUILDING_MS = 24 * 3600_000;
/** Change records older than this are removed by `cleanup`. */
const CHANGE_RETENTION_MS = 180 * 86400_000;

/** Every table keyed by `snapshot_id` that holds a snapshot's index. */
const SNAPSHOT_TABLES = [
  "sections_fts",
  "section_anchors",
  "enum_keys",
  "enums",
  "fields",
  "objects",
  "endpoints",
  "changelog_entries",
  "redirects",
  "snapshot_files",
  "sections",
  "pages",
] as const;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const part of chunks(statements, MAX_BATCH)) await db.batch(part);
}

/** `?<start>, ?<start+1>, ...` for `count` numbered parameters. */
const placeholders = (start: number, count: number): string => Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");

export async function createSnapshot(db: D1Database, commitSha: string): Promise<number> {
  const res = await db
    .prepare("INSERT INTO snapshots (commit_sha, created_at, status) VALUES (?1, ?2, 'building')")
    .bind(commitSha, new Date().toISOString())
    .run();
  return res.meta.last_row_id;
}

/**
 * Statements that remove everything stored for `paths` in one snapshot. Entity and FTS rows hang off section
 * ids, so they go first. The change log is not attached to a section, so it is cleared whole when its page is in.
 */
function deletePageStatements(db: D1Database, snapshotId: number, paths: string[]): D1PreparedStatement[] {
  const bind = [snapshotId, ...paths];
  const inPaths = placeholders(2, paths.length);
  const sectionIds = `SELECT id FROM sections WHERE snapshot_id = ?1 AND page_path IN (${inPaths})`;
  const out: D1PreparedStatement[] = [];
  for (const t of ["sections_fts"]) out.push(db.prepare(`DELETE FROM ${t} WHERE snapshot_id = ?1 AND section_id IN (${sectionIds})`).bind(...bind));
  for (const t of ["endpoints", "objects", "fields", "enums", "enum_keys"])
    out.push(db.prepare(`DELETE FROM ${t} WHERE snapshot_id = ?1 AND section_id IN (${sectionIds})`).bind(...bind));
  if (paths.includes(CHANGELOG_PATH)) out.push(db.prepare("DELETE FROM changelog_entries WHERE snapshot_id = ?1").bind(snapshotId));
  out.push(db.prepare(`DELETE FROM section_anchors WHERE snapshot_id = ?1 AND page_path IN (${inPaths})`).bind(...bind));
  out.push(db.prepare(`DELETE FROM sections WHERE snapshot_id = ?1 AND page_path IN (${inPaths})`).bind(...bind));
  out.push(db.prepare(`DELETE FROM pages WHERE snapshot_id = ?1 AND path IN (${inPaths})`).bind(...bind));
  return out;
}

async function deletePages(db: D1Database, snapshotId: number, paths: string[]): Promise<void> {
  for (const chunk of chunks(paths, PATH_CHUNK)) await db.batch(deletePageStatements(db, snapshotId, chunk));
}

/** Trailing footnote marker characters of a docs table cell (`ADMINISTRATOR *`, `FOO†`). */
const KEY_MARKER_CHARS = new Set(["*", "†", "‡", "§"]);

/** Longest cell considered for a lookup key; real keys are far shorter. */
const KEY_MAX_CHARS = 200;

/** Strip trailing whitespace and footnote markers in one linear pass (no regex backtracking). */
function stripKeyMarker(cell: string): string {
  const s = cell.slice(0, KEY_MAX_CHARS);
  let end = s.length;
  while (end > 0 && (KEY_MARKER_CHARS.has(s[end - 1]!) || /\s/u.test(s[end - 1]!))) end--;
  return s.slice(0, end);
}

/** Enum lookup key per row: the "name"-like column when there is one, else the first column, without footnote markers. */
function enumKeys(e: ParsedEnum): string[] {
  const lower = e.columns.map((c) => c.toLowerCase());
  const idx = Math.max(0, lower.findIndex((c) => ["name", "key", "flag", "permission"].includes(c)));
  return e.rows.map((r) => stripKeyMarker(r[idx] ?? "")).filter((k) => k !== "");
}

/**
 * Write parsed pages into a (building) snapshot. Safe to re-run for the same pages: existing rows for those
 * paths are removed first. `blobShas` maps a page path (`resources/channel`) or its repo path
 * (`developers/resources/channel.mdx`) to the git blob sha of its source file.
 */
export async function writePages(db: D1Database, snapshotId: number, pages: ParsedPage[], blobShas: Map<string, string>): Promise<void> {
  await deletePages(db, snapshotId, [...new Set(pages.map((p) => p.meta.path))]);

  const s: D1PreparedStatement[] = [];
  for (const page of pages) {
    const m = page.meta;
    const blob = blobShas.get(m.path) ?? blobShas.get(`developers/${m.path}.mdx`) ?? null;
    s.push(
      db
        .prepare(
          "INSERT INTO pages (snapshot_id, path, title, sidebar_title, description, breadcrumb, url, blob_sha, snippet_deps, problems) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(snapshotId, m.path, m.title, m.sidebarTitle ?? null, m.description ?? null, JSON.stringify(m.breadcrumb), m.url, blob, JSON.stringify(page.snippetDeps), JSON.stringify(page.problems)),
    );

    const seenAnchors = new Set<string>();
    for (const sec of page.sections) {
      s.push(
        db
          .prepare(
            "INSERT INTO sections (snapshot_id, id, base_id, page_path, area, anchor, heading, heading_path, level, part, ord, markdown, content_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
          )
          .bind(snapshotId, sec.id, sec.baseId, sec.pagePath, sec.area, sec.anchor, sec.heading, JSON.stringify(sec.headingPath), sec.level, sec.part, sec.ord, sec.markdown, sec.contentHash),
      );
      s.push(
        db
          .prepare("INSERT INTO sections_fts (snapshot_id, section_id, area, heading_path, title, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(snapshotId, sec.id, sec.area, sec.headingPath.join(" > "), m.title, sec.markdown),
      );
      // A section's own anchor resolves to its first part; sub-anchors to the part that contains them.
      for (const a of [sec.anchor, ...sec.subAnchors]) {
        if (a === "" || seenAnchors.has(a)) continue;
        seenAnchors.add(a);
        s.push(
          db.prepare("INSERT INTO section_anchors (snapshot_id, page_path, anchor, section_id) VALUES (?1, ?2, ?3, ?4)").bind(snapshotId, sec.pagePath, a, sec.id),
        );
      }
    }

    for (const e of page.endpoints)
      s.push(
        db
          .prepare("INSERT INTO endpoints (snapshot_id, name, method, path_template, normalized_path, section_id, params) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(snapshotId, e.name, e.method, e.pathTemplate, e.normalizedPath, e.sectionId, JSON.stringify(e.params)),
      );
    for (const o of page.objects) {
      s.push(db.prepare("INSERT INTO objects (snapshot_id, name, section_id, fields) VALUES (?1, ?2, ?3, ?4)").bind(snapshotId, o.name, o.sectionId, JSON.stringify(o.fields)));
      for (const f of o.fields)
        s.push(db.prepare("INSERT INTO fields (snapshot_id, object_name, name, section_id) VALUES (?1, ?2, ?3, ?4)").bind(snapshotId, o.name, f.name, o.sectionId));
    }
    for (const e of page.enums) {
      s.push(
        db
          .prepare("INSERT INTO enums (snapshot_id, name, section_id, owner_object, columns, rows) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
          .bind(snapshotId, e.name, e.sectionId, e.ownerObject, JSON.stringify(e.columns), JSON.stringify(e.rows)),
      );
      for (const key of enumKeys(e))
        s.push(db.prepare("INSERT INTO enum_keys (snapshot_id, enum_name, key, section_id) VALUES (?1, ?2, ?3, ?4)").bind(snapshotId, e.name, key, e.sectionId));
    }
    for (const c of page.changelog)
      s.push(
        db
          .prepare("INSERT INTO changelog_entries (snapshot_id, id, date, tags, title, description, markdown, links, url) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
          .bind(snapshotId, c.id, c.date, JSON.stringify(c.tags), c.title, c.description, c.markdown, JSON.stringify(c.links), c.url),
      );
  }
  await runBatched(db, s);
}

/** `INSERT ... SELECT` that re-keys rows from snapshot ?1 to snapshot ?2. `cols` excludes snapshot_id. */
const copyStatement = (db: D1Database, table: string, cols: string, where: string, bind: unknown[]): D1PreparedStatement =>
  db.prepare(`INSERT INTO ${table} (snapshot_id, ${cols}) SELECT ?2, ${cols} FROM ${table} WHERE snapshot_id = ?1 AND ${where}`).bind(...bind);

/**
 * Copy the index rows of unchanged pages from one snapshot to another (FTS rows included). Safe to re-run:
 * target rows for those pages are replaced. Redirects and snapshot files are not copied (see writeRedirects,
 * writeSnapshotFiles).
 */
export async function copyPages(db: D1Database, fromSnapshot: number, toSnapshot: number, pagePaths: string[]): Promise<void> {
  const paths = [...new Set(pagePaths)];
  await deletePages(db, toSnapshot, paths);
  for (const chunk of chunks(paths, PATH_CHUNK)) {
    const bind = [fromSnapshot, toSnapshot, ...chunk];
    const inPaths = placeholders(3, chunk.length);
    const sectionIds = `section_id IN (SELECT id FROM sections WHERE snapshot_id = ?1 AND page_path IN (${inPaths}))`;
    const s: D1PreparedStatement[] = [
      copyStatement(db, "pages", "path, title, sidebar_title, description, breadcrumb, url, blob_sha, snippet_deps, problems", `path IN (${inPaths})`, bind),
      copyStatement(db, "sections", "id, base_id, page_path, area, anchor, heading, heading_path, level, part, ord, markdown, content_hash", `page_path IN (${inPaths})`, bind),
      copyStatement(db, "sections_fts", "section_id, area, heading_path, title, body", sectionIds, bind),
      copyStatement(db, "section_anchors", "page_path, anchor, section_id", `page_path IN (${inPaths})`, bind),
      copyStatement(db, "endpoints", "name, method, path_template, normalized_path, section_id, params", sectionIds, bind),
      copyStatement(db, "objects", "name, section_id, fields", sectionIds, bind),
      copyStatement(db, "fields", "object_name, name, section_id", sectionIds, bind),
      copyStatement(db, "enums", "name, section_id, owner_object, columns, rows", sectionIds, bind),
      copyStatement(db, "enum_keys", "enum_name, key, section_id", sectionIds, bind),
    ];
    if (chunk.includes(CHANGELOG_PATH))
      s.push(copyStatement(db, "changelog_entries", "id, date, tags, title, description, markdown, links, url", "1 = 1", [fromSnapshot, toSnapshot]));
    await db.batch(s);
  }
}

export async function writeRedirects(db: D1Database, snapshotId: number, redirects: Array<{ source: string; destination: string }>): Promise<void> {
  const s: D1PreparedStatement[] = [db.prepare("DELETE FROM redirects WHERE snapshot_id = ?1").bind(snapshotId)];
  for (const r of redirects)
    s.push(db.prepare("INSERT INTO redirects (snapshot_id, source, destination) VALUES (?1, ?2, ?3)").bind(snapshotId, r.source, r.destination));
  await runBatched(db, s);
}

/** Record which source blob each file of the snapshot's commit has. Re-runnable: a later write for a path wins. */
export async function writeSnapshotFiles(db: D1Database, snapshotId: number, files: Array<{ path: string; blobSha: string }>): Promise<void> {
  await runBatched(
    db,
    files.map((f) =>
      db
        .prepare("INSERT OR REPLACE INTO snapshot_files (snapshot_id, path, blob_sha) VALUES (?1, ?2, ?3)")
        .bind(snapshotId, f.path, f.blobSha),
    ),
  );
}

/** Store fetched source text by git blob sha. A blob's content never changes, so duplicates are ignored. */
export async function writeFileContents(db: D1Database, files: Array<{ blobSha: string; content: string }>): Promise<void> {
  await runBatched(
    db,
    files.map((f) => db.prepare("INSERT OR IGNORE INTO file_contents (blob_sha, content) VALUES (?1, ?2)").bind(f.blobSha, f.content)),
  );
}

/**
 * Make `newId` the live snapshot if the pointer still equals `expectedCurrent`. One batch (one transaction), but
 * D1 does not roll back when the CAS changes 0 rows, so the status updates are conditional on the pointer
 * actually being `newId`. Returns false (and changes nothing) when the pointer moved.
 */
export async function publishSnapshot(db: D1Database, newId: number, expectedCurrent: number | null): Promise<boolean> {
  if (expectedCurrent === newId) return false;
  const pointerIsNew = "(SELECT current_snapshot FROM refresh_state WHERE id = 1) = ?1";
  const s: D1PreparedStatement[] = [
    db
      .prepare("UPDATE refresh_state SET current_snapshot = ?1, last_success_at = ?2 WHERE id = 1 AND current_snapshot IS ?3")
      .bind(newId, new Date().toISOString(), expectedCurrent),
    db.prepare(`UPDATE snapshots SET status = 'live' WHERE id = ?1 AND ${pointerIsNew}`).bind(newId),
  ];
  if (expectedCurrent !== null)
    s.push(db.prepare(`UPDATE snapshots SET status = 'retired' WHERE id = ?2 AND status = 'live' AND ${pointerIsNew}`).bind(newId, expectedCurrent));
  const res = await db.batch(s);
  return res[0].meta.changes === 1;
}

/**
 * Remove the data of dead snapshots and expired records:
 * - snapshots with status `retired` or `failed`, and `building` ones created more than 24 h before `now`
 *   (abandoned runs). The current snapshot and recent `building` ones are never touched.
 * - `file_contents` no remaining `snapshot_files` row points at. Callers write file contents before the
 *   snapshot's files, so run cleanup only while no refresh is mid-fetch (it runs as the last workflow step).
 * - `change_records` older than 180 days.
 */
export async function cleanup(db: D1Database, now: Date): Promise<void> {
  const buildingCutoff = new Date(now.getTime() - STALE_BUILDING_MS).toISOString();
  const victims = await db
    .prepare(
      `SELECT id FROM snapshots
       WHERE (status IN ('retired', 'failed') OR (status = 'building' AND created_at < ?1))
         AND id IS NOT (SELECT current_snapshot FROM refresh_state WHERE id = 1)`,
    )
    .bind(buildingCutoff)
    .all<{ id: number }>();

  const s: D1PreparedStatement[] = [];
  for (const { id } of victims.results) {
    for (const t of SNAPSHOT_TABLES) s.push(db.prepare(`DELETE FROM ${t} WHERE snapshot_id = ?1`).bind(id));
    s.push(db.prepare("DELETE FROM snapshots WHERE id = ?1").bind(id)); // last: a half-done cleanup is retried next time
  }
  s.push(db.prepare("DELETE FROM file_contents WHERE blob_sha NOT IN (SELECT blob_sha FROM snapshot_files)"));
  s.push(db.prepare("DELETE FROM change_records WHERE date < ?1").bind(new Date(now.getTime() - CHANGE_RETENTION_MS).toISOString()));
  await runBatched(db, s);
}

/** One `runs` row (see migrations). Booleans are stored as 0/1, `problems` as a JSON array. */
export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  commitSha: string | null;
  baseSnapshot: number | null;
  newSnapshot: number | null;
  baseline: boolean;
  forced: boolean;
  outcome: string;
  filesChanged: number;
  sectionsAdded: number;
  sectionsModified: number;
  sectionsRemoved: number;
  durationMs: number | null;
  problems: string[];
}

/** Insert or replace a refresh run's row (a run's row is rewritten as it progresses). */
export async function writeRun(db: D1Database, r: RunRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO runs (id, started_at, finished_at, commit_sha, base_snapshot, new_snapshot, baseline, forced, outcome,
         files_changed, sections_added, sections_modified, sections_removed, duration_ms, problems)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      r.id, r.startedAt, r.finishedAt, r.commitSha, r.baseSnapshot, r.newSnapshot, r.baseline ? 1 : 0, r.forced ? 1 : 0, r.outcome,
      r.filesChanged, r.sectionsAdded, r.sectionsModified, r.sectionsRemoved, r.durationMs, JSON.stringify(r.problems),
    )
    .run();
}

export interface ChangeRecordInput {
  sectionId: string;
  heading: string;
  url: string;
  changeType: "added" | "modified" | "removed";
}

/** Rows per multi-row change_records INSERT: 7 bound parameters each stays under D1's 100. */
const CHANGE_ROWS_PER_INSERT = 14;

/** Replace the change records of a run (re-runnable: the run's earlier rows are removed first). */
export async function writeChangeRecords(db: D1Database, runId: string, commitSha: string, date: string, records: ChangeRecordInput[]): Promise<void> {
  const s: D1PreparedStatement[] = [db.prepare("DELETE FROM change_records WHERE run_id = ?1").bind(runId)];
  for (const part of chunks(records, CHANGE_ROWS_PER_INSERT)) {
    const values = part.map((_, i) => `(${placeholders(i * 7 + 1, 7)})`).join(", ");
    const bind = part.flatMap((r) => [runId, commitSha, date, r.sectionId, r.heading, r.url, r.changeType]);
    s.push(db.prepare(`INSERT INTO change_records (run_id, commit_sha, date, section_id, heading, url, change_type) VALUES ${values}`).bind(...bind));
  }
  await runBatched(db, s);
}

/**
 * Record the outcome of the latest run in `refresh_state`. `success` also sets `last_success_at` (a no-op run
 * confirms the index is current, so it counts as a success for staleness). Never touches `current_snapshot`.
 */
export async function recordRunState(db: D1Database, outcome: string, at: string, success: boolean): Promise<void> {
  await db
    .prepare(
      `UPDATE refresh_state SET last_run_at = ?1, last_run_outcome = ?2, last_success_at = CASE WHEN ?3 THEN ?1 ELSE last_success_at END WHERE id = 1`,
    )
    .bind(at, outcome, success ? 1 : 0)
    .run();
}

/** Mark a snapshot that is still being built as failed (cleanup removes it). Never touches a live snapshot. */
export async function markSnapshotFailed(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE snapshots SET status = 'failed' WHERE id = ?1 AND status = 'building'").bind(id).run();
}
