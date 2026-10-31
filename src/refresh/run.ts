import { log } from "../log";
import { pagePathFromRepoPath, pageUrl, parseNavigation } from "../parse/navigation";
import { parsePage, type PageContext, type ParsedPage } from "../parse/page";
import {
  cleanup,
  copyPages,
  createSnapshot,
  markSnapshotFailed,
  publishSnapshot,
  recordRunState,
  writeChangeRecords,
  writeFileContents,
  writePages,
  writeRedirects,
  writeRun,
  writeSnapshotFiles,
  type ChangeRecordInput,
  type RunRecord,
} from "../store/write";
import type { GitHubSource } from "./github";

/**
 * Durable step executor. In production each call is a Workflow step (retried on failure, its result persisted
 * and replayed), so every step body here is idempotent and returns only small JSON-serializable values.
 */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface RunSummary {
  outcome: "noop" | "published" | "lost-race" | "failed";
  commitSha: string;
  /** true when there was no snapshot to compare against (first build); no change records then */
  baseline: boolean;
  /** selected files added + modified + removed relative to the base snapshot */
  filesChanged: number;
  sectionsAdded: number;
  sectionsModified: number;
  sectionsRemoved: number;
}

export interface RefreshDeps {
  db: D1Database;
  source: GitHubSource;
  splitChars: number;
  now: () => Date;
}

const DOCS_JSON = "docs.json";
/** Pages parsed and written per `parse:<n>` step (keeps each step's CPU time and D1 calls modest). */
const PAGES_PER_PARSE_STEP = 25;
/** `fetch:*` steps started at once. */
const FETCH_CONCURRENCY = 6;
/** Values per `IN (...)` list (D1 allows 100 bound parameters per statement). */
const IN_CHUNK = 90;
/** Parser problems kept in a `runs` row. */
const MAX_PROBLEMS = 100;

const isPage = (p: string): boolean => p.startsWith("developers/") && p.endsWith(".mdx");
const isSnippet = (p: string): boolean => p.startsWith("snippets/") && p.endsWith(".mdx");
const isSelected = (p: string): boolean => p === DOCS_JSON || isPage(p) || isSnippet(p);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
const marks = (start: number, count: number): string => Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 500);

/** Result of `resolve-head`. */
interface Head {
  sha: string;
  startedAt: string;
  baseSnapshot: number | null;
  baseCommit: string | null;
  noop: boolean;
}

/** Result of `fetch-tree`: what this run downloads, parses and copies. Repo paths unless noted. */
interface Plan {
  snapshotId: number;
  filesChanged: number;
  /** blobs not yet in file_contents that this run needs (one path per distinct blob) */
  download: Array<{ path: string; sha: string }>;
  /** pages to parse */
  parse: string[];
  /** page paths (`resources/channel`) copied unchanged from the base snapshot */
  copy: string[];
}

interface PublishResult {
  outcome: "published" | "lost-race";
  added: number;
  modified: number;
  removed: number;
}

/**
 * One refresh run: resolve the head of `main`, diff its tree against the current snapshot, download what is
 * missing, parse what changed into a new snapshot, copy the rest, and publish it with a compare-and-swap on
 * the snapshot pointer. Readers keep seeing the previous snapshot until the publish; a failure anywhere is
 * recorded (`record-failure`) and rethrown, and never changes what readers see.
 *
 * Every D1 write and network call happens inside a step, and state crosses steps only through step results,
 * so a Workflow can replay this function safely.
 */
export async function runRefresh(deps: RefreshDeps, opts: { runId: string; force: boolean }, step: StepRunner): Promise<RunSummary> {
  const { db, source, now } = deps;
  const { runId, force } = opts;
  let head: Head | undefined;
  let t = Date.now();
  const phase = (name: string, counts: Record<string, number> = {}): void => {
    log("refresh.step", { runId, commitSha: head?.sha ?? null, step: name, ...counts, durationMs: Date.now() - t });
    t = Date.now();
  };

  try {
    head = await step.do("resolve-head", () => resolveHead(deps, runId, force));
    const h = head;
    const baseline = h.baseSnapshot === null;
    phase("resolve-head");
    if (h.noop) {
      log("refresh.done", { runId, commitSha: h.sha, outcome: "noop" });
      return { outcome: "noop", commitSha: h.sha, baseline: false, filesChanged: 0, sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: 0 };
    }

    const plan = await step.do("fetch-tree", () => planRun(deps, runId, force, h));
    phase("fetch-tree", { files: plan.filesChanged, downloads: plan.download.length, parse: plan.parse.length, copy: plan.copy.length });

    for (const batch of chunks(plan.download, FETCH_CONCURRENCY)) {
      await Promise.all(
        batch.map((f) =>
          step.do(`fetch:${f.path}@${f.sha}`, async () => {
            const content = await source.raw(h.sha, f.path);
            await writeFileContents(db, [{ blobSha: f.sha, content }]);
          }),
        ),
      );
    }
    phase("fetch", { files: plan.download.length });

    let sections = 0;
    for (const [n, paths] of chunks(plan.parse, PAGES_PER_PARSE_STEP).entries()) {
      const r = await step.do(`parse:${n}`, () => parseChunk(deps, plan.snapshotId, paths));
      sections += r.sections;
    }
    phase("parse", { pages: plan.parse.length, sections });

    await step.do("copy-unchanged", async () => {
      if (h.baseSnapshot !== null && plan.copy.length > 0) await copyPages(db, h.baseSnapshot, plan.snapshotId, plan.copy);
      // Redirects are derived from the new docs.json for every snapshot; copyPages does not carry them.
      const docs = (await loadContents(db, plan.snapshotId, [DOCS_JSON])).get(DOCS_JSON)!;
      await writeRedirects(db, plan.snapshotId, parseNavigation(docs.content).redirects);
      return { pages: plan.copy.length };
    });
    phase("copy-unchanged", { pages: plan.copy.length });

    const pub = await step.do("publish", () => publish(deps, runId, force, h, plan));
    phase("publish");

    if (pub.outcome === "published") {
      // Cleanup deletes file_contents no snapshot_files row points at, and dead snapshots. It must not run
      // while another refresh is mid-fetch: Task 10 makes the refresh single-flight (fixed Workflow instance
      // policy / limiter). It is housekeeping only, so its failure does not fail a published run.
      try {
        await step.do("cleanup", async () => {
          await cleanup(db, now());
        });
        phase("cleanup");
      } catch (e) {
        log("refresh.cleanup_failed", { runId, commitSha: h.sha, error: errorText(e) });
      }
    }

    const summary: RunSummary = {
      outcome: pub.outcome,
      commitSha: h.sha,
      baseline,
      filesChanged: plan.filesChanged,
      sectionsAdded: pub.added,
      sectionsModified: pub.modified,
      sectionsRemoved: pub.removed,
    };
    log("refresh.done", { runId, commitSha: h.sha, outcome: summary.outcome, filesChanged: summary.filesChanged, sectionsAdded: pub.added, sectionsModified: pub.modified, sectionsRemoved: pub.removed });
    return summary;
  } catch (err) {
    try {
      await step.do("record-failure", () => recordFailure(deps, runId, force, head, err));
    } catch (e) {
      log("refresh.record_failure_failed", { runId, commitSha: head?.sha ?? null, error: errorText(e) });
    }
    log("refresh.failed", { runId, commitSha: head?.sha ?? null, error: errorText(err) });
    throw err;
  }
}

/**
 * `resolve-head`: head sha, start time and the base (current) snapshot. A no-op run (head already indexed,
 * not forced) is recorded here: a `runs` row, and `last_success_at` refreshed since the index is confirmed current.
 */
async function resolveHead({ db, source, now }: RefreshDeps, runId: string, force: boolean): Promise<Head> {
  const sha = await source.headSha();
  const startedAt = now().toISOString();
  const cur = await db
    .prepare("SELECT s.id AS id, s.commit_sha AS commit_sha FROM refresh_state rs JOIN snapshots s ON s.id = rs.current_snapshot WHERE rs.id = 1")
    .first<{ id: number; commit_sha: string }>();
  const head: Head = { sha, startedAt, baseSnapshot: cur?.id ?? null, baseCommit: cur?.commit_sha ?? null, noop: !force && cur !== null && cur.commit_sha === sha };
  if (head.noop) {
    await writeRun(db, {
      ...emptyRun(runId, startedAt, sha, head.baseSnapshot, force),
      finishedAt: startedAt,
      outcome: "noop",
      durationMs: 0,
    });
    await recordRunState(db, "noop", startedAt, true);
  }
  return head;
}

function emptyRun(id: string, startedAt: string, commitSha: string | null, baseSnapshot: number | null, forced: boolean): RunRecord {
  return {
    id,
    startedAt,
    finishedAt: null,
    commitSha,
    baseSnapshot,
    newSnapshot: null,
    baseline: false,
    forced,
    outcome: "running",
    filesChanged: 0,
    sectionsAdded: 0,
    sectionsModified: 0,
    sectionsRemoved: 0,
    durationMs: null,
    problems: [],
  };
}

/**
 * `fetch-tree`: fetch the commit's tree, classify the selected files against the base snapshot, create the new
 * (building) snapshot and record its files. The snapshot id is kept in the run's `runs` row so a retried step
 * reuses it instead of leaving an orphan behind.
 */
async function planRun({ db, source }: RefreshDeps, runId: string, force: boolean, head: Head): Promise<Plan> {
  const entries = (await source.tree(head.sha)).filter((e) => isSelected(e.path));
  const files = new Map(entries.map((e) => [e.path, e.sha]));
  if (!files.has(DOCS_JSON)) throw new Error("docs.json missing from tree");

  const baseFiles = new Map<string, string>();
  const basePages = new Map<string, { deps: string[]; problems: string[] }>();
  if (head.baseSnapshot !== null) {
    const f = await db.prepare("SELECT path, blob_sha FROM snapshot_files WHERE snapshot_id = ?1").bind(head.baseSnapshot).all<{ path: string; blob_sha: string }>();
    for (const r of f.results) baseFiles.set(r.path, r.blob_sha);
    const p = await db
      .prepare("SELECT path, snippet_deps, problems FROM pages WHERE snapshot_id = ?1")
      .bind(head.baseSnapshot)
      .all<{ path: string; snippet_deps: string | null; problems: string | null }>();
    for (const r of p.results) basePages.set(r.path, { deps: JSON.parse(r.snippet_deps ?? "[]"), problems: JSON.parse(r.problems ?? "[]") });
  }

  const changed = new Set<string>();
  const removed: string[] = [];
  for (const [path, sha] of files) if (baseFiles.get(path) !== sha) changed.add(path);
  for (const path of baseFiles.keys()) if (!files.has(path)) removed.push(path);

  const pages = [...files.keys()].filter(isPage).sort();
  let parse: string[];
  if (force || head.baseSnapshot === null || changed.has(DOCS_JSON)) {
    parse = pages; // docs.json drives every page's breadcrumb
  } else {
    // A changed, added or removed snippet re-parses its importers: pages that inlined it (snippet_deps holds
    // repo paths, transitively) or that could not find it before (`missing snippet: <repo path>` problem).
    const snippets = [...changed, ...removed].filter(isSnippet);
    const importer = (pagePath: string): boolean => {
      const p = basePages.get(pagePath);
      return !!p && snippets.some((s) => p.deps.includes(s) || p.problems.includes(`missing snippet: ${s}`));
    };
    // A page missing from the base snapshot cannot be copied, so it is parsed too.
    parse = pages.filter((p) => changed.has(p) || !basePages.has(pagePathFromRepoPath(p)) || importer(pagePathFromRepoPath(p)));
  }
  const parsing = new Set(parse);
  const copy = pages.filter((p) => !parsing.has(p)).map(pagePathFromRepoPath);

  const reuse = await db
    .prepare(
      `SELECT r.new_snapshot AS id FROM runs r JOIN snapshots s ON s.id = r.new_snapshot
       WHERE r.id = ?1 AND r.outcome = 'running' AND s.status = 'building' AND s.commit_sha = ?2`,
    )
    .bind(runId, head.sha)
    .first<{ id: number }>();
  const snapshotId = reuse?.id ?? (await createSnapshot(db, head.sha));
  const filesChanged = changed.size + removed.length;
  await writeRun(db, {
    ...emptyRun(runId, head.startedAt, head.sha, head.baseSnapshot, force),
    newSnapshot: snapshotId,
    baseline: head.baseSnapshot === null,
    filesChanged,
  });
  // Recorded before any download, so cleanup (which keeps blobs referenced by snapshot_files) never drops them.
  await writeSnapshotFiles(db, snapshotId, entries.map((e) => ({ path: e.path, blobSha: e.sha })));

  // Download a blob only when it is needed (docs.json, snippets, pages to parse) and not stored yet: this makes
  // the run incremental, retry-safe, and fetches identical contents once.
  const needed = new Map<string, string>(); // blob sha -> first path
  for (const path of [DOCS_JSON, ...[...files.keys()].filter(isSnippet).sort(), ...parse]) {
    const sha = files.get(path)!;
    if (!needed.has(sha)) needed.set(sha, path);
  }
  const stored = new Set<string>();
  for (const part of chunks([...needed.keys()], IN_CHUNK)) {
    const r = await db.prepare(`SELECT blob_sha FROM file_contents WHERE blob_sha IN (${marks(1, part.length)})`).bind(...part).all<{ blob_sha: string }>();
    for (const row of r.results) stored.add(row.blob_sha);
  }
  const download = [...needed].filter(([sha]) => !stored.has(sha)).map(([sha, path]) => ({ path, sha }));
  return { snapshotId, filesChanged, download, parse, copy };
}

/** Source text and blob sha of `paths` in a snapshot. Every path must have been downloaded. */
async function loadContents(db: D1Database, snapshotId: number, paths: string[]): Promise<Map<string, { sha: string; content: string }>> {
  const out = new Map<string, { sha: string; content: string }>();
  for (const part of chunks(paths, IN_CHUNK)) {
    const r = await db
      .prepare(
        `SELECT sf.path AS path, sf.blob_sha AS sha, fc.content AS content FROM snapshot_files sf
         LEFT JOIN file_contents fc ON fc.blob_sha = sf.blob_sha
         WHERE sf.snapshot_id = ?1 AND sf.path IN (${marks(2, part.length)})`,
      )
      .bind(snapshotId, ...part)
      .all<{ path: string; sha: string; content: string | null }>();
    for (const row of r.results) if (row.content !== null) out.set(row.path, { sha: row.sha, content: row.content });
  }
  for (const p of paths) if (!out.has(p)) throw new Error(`missing content for ${p}`);
  return out;
}

/** Parser context from the new snapshot's files: navigation from its docs.json, every snippet by repo path. */
async function loadContext(db: D1Database, snapshotId: number, splitChars: number): Promise<PageContext> {
  const r = await db
    .prepare("SELECT path FROM snapshot_files WHERE snapshot_id = ?1 AND (path = ?2 OR path LIKE 'snippets/%')")
    .bind(snapshotId, DOCS_JSON)
    .all<{ path: string }>();
  const contents = await loadContents(db, snapshotId, r.results.map((x) => x.path).filter((p) => p === DOCS_JSON || isSnippet(p)));
  const snippets = new Map<string, string>();
  for (const [path, c] of contents) if (isSnippet(path)) snippets.set(path, c.content);
  return { snippets, nav: parseNavigation(contents.get(DOCS_JSON)!.content), splitChars };
}

/** `parse:<n>`: parse a chunk of pages and write them into the new snapshot. Returns counts only. */
async function parseChunk(deps: RefreshDeps, snapshotId: number, paths: string[]): Promise<{ pages: number; sections: number }> {
  const ctx = await loadContext(deps.db, snapshotId, deps.splitChars);
  const contents = await loadContents(deps.db, snapshotId, paths);
  const pages: ParsedPage[] = [];
  for (const path of paths) pages.push(await parsePage({ path, content: contents.get(path)!.content }, ctx));
  // keys are repo paths, as stored in snapshot_files
  await writePages(deps.db, snapshotId, pages, new Map(paths.map((p) => [p, contents.get(p)!.sha])));
  return { pages: pages.length, sections: pages.reduce((n, p) => n + p.sections.length, 0) };
}

/**
 * Section-level changes between two snapshots, one record per section (its `baseId`, the id readers and
 * search use; a long section's parts are compared together). A section is added/removed when its baseId only
 * exists on one side, modified when any of its parts' (id, content_hash) differ. Unchanged pages were copied
 * verbatim, so diffing whole snapshots equals diffing the parsed and removed pages.
 */
async function diffSections(db: D1Database, base: number, next: number): Promise<ChangeRecordInput[]> {
  const r = await db
    .prepare(
      `WITH n AS (SELECT id, base_id, content_hash FROM sections WHERE snapshot_id = ?1),
            b AS (SELECT id, base_id, content_hash FROM sections WHERE snapshot_id = ?2),
            changed AS (
              SELECT n.base_id AS base_id FROM n LEFT JOIN b ON b.id = n.id AND b.content_hash = n.content_hash WHERE b.id IS NULL
              UNION
              SELECT b.base_id FROM b LEFT JOIN n ON n.id = b.id AND n.content_hash = b.content_hash WHERE n.id IS NULL
            )
       SELECT c.base_id AS base_id, ns.id IS NOT NULL AS in_new, bs.id IS NOT NULL AS in_base,
              COALESCE(ns.heading, bs.heading) AS heading, COALESCE(ns.page_path, bs.page_path) AS page_path,
              COALESCE(ns.anchor, bs.anchor) AS anchor
       FROM changed c
       LEFT JOIN sections ns ON ns.snapshot_id = ?1 AND ns.id = c.base_id
       LEFT JOIN sections bs ON bs.snapshot_id = ?2 AND bs.id = c.base_id
       ORDER BY c.base_id`,
    )
    .bind(next, base)
    .all<{ base_id: string; in_new: number; in_base: number; heading: string; page_path: string; anchor: string }>();
  return r.results.map((row) => ({
    sectionId: row.base_id,
    heading: row.heading,
    url: pageUrl(row.page_path, row.anchor || undefined),
    changeType: row.in_new && row.in_base ? "modified" : row.in_new ? "added" : "removed",
  }));
}

/** Parser problems of a snapshot's pages, capped for the `runs` row. */
async function snapshotProblems(db: D1Database, snapshotId: number): Promise<string[]> {
  const r = await db.prepare("SELECT problems FROM pages WHERE snapshot_id = ?1 AND problems != '[]' ORDER BY path").bind(snapshotId).all<{ problems: string }>();
  const all = r.results.flatMap((x) => JSON.parse(x.problems) as string[]);
  return all.length > MAX_PROBLEMS ? [...all.slice(0, MAX_PROBLEMS), `... and ${all.length - MAX_PROBLEMS} more`] : all;
}

/**
 * `publish`: compare-and-swap the snapshot pointer from the base to the new snapshot, then record the run.
 * publishSnapshot also returns false when this step is retried after its publish committed, so a false with
 * the pointer already on our snapshot counts as published. A genuine lost race marks only our snapshot
 * failed and leaves the winner's refresh_state alone. Change records are replaced per run, so a retry is safe.
 */
async function publish({ db, now }: RefreshDeps, runId: string, force: boolean, head: Head, plan: Plan): Promise<PublishResult> {
  const at = now().toISOString();
  let ok = await publishSnapshot(db, plan.snapshotId, head.baseSnapshot);
  if (!ok) {
    const cur = await db.prepare("SELECT current_snapshot FROM refresh_state WHERE id = 1").first<{ current_snapshot: number | null }>();
    ok = cur?.current_snapshot === plan.snapshotId;
  }
  const run: RunRecord = {
    ...emptyRun(runId, head.startedAt, head.sha, head.baseSnapshot, force),
    finishedAt: at,
    newSnapshot: plan.snapshotId,
    baseline: head.baseSnapshot === null,
    filesChanged: plan.filesChanged,
    durationMs: Date.parse(at) - Date.parse(head.startedAt),
  };
  if (!ok) {
    await markSnapshotFailed(db, plan.snapshotId);
    await writeRun(db, { ...run, outcome: "lost-race" });
    return { outcome: "lost-race", added: 0, modified: 0, removed: 0 };
  }

  // No change records for the baseline, nor for a forced re-parse of the already indexed commit.
  const records = head.baseSnapshot === null || head.sha === head.baseCommit ? [] : await diffSections(db, head.baseSnapshot, plan.snapshotId);
  await writeChangeRecords(db, runId, head.sha, at.slice(0, 10), records);
  const n = (type: ChangeRecordInput["changeType"]) => records.filter((r) => r.changeType === type).length;
  const result: PublishResult = { outcome: "published", added: n("added"), modified: n("modified"), removed: n("removed") };
  await writeRun(db, {
    ...run,
    outcome: "published",
    sectionsAdded: result.added,
    sectionsModified: result.modified,
    sectionsRemoved: result.removed,
    problems: await snapshotProblems(db, plan.snapshotId),
  });
  await recordRunState(db, "published", at, true);
  return result;
}

/**
 * `record-failure`: a `failed` runs row, `refresh_state.last_run_outcome = 'failed'`, and the run's building
 * snapshot (if one was created) marked failed. Never touches the current snapshot pointer.
 */
async function recordFailure({ db, now }: RefreshDeps, runId: string, force: boolean, head: Head | undefined, err: unknown): Promise<void> {
  const at = now().toISOString();
  const prev = await db.prepare("SELECT new_snapshot, files_changed, started_at FROM runs WHERE id = ?1").bind(runId).first<{
    new_snapshot: number | null;
    files_changed: number | null;
    started_at: string | null;
  }>();
  const newSnapshot = prev?.new_snapshot ?? null;
  if (newSnapshot !== null) await markSnapshotFailed(db, newSnapshot);
  const startedAt = head?.startedAt ?? prev?.started_at ?? at;
  await writeRun(db, {
    ...emptyRun(runId, startedAt, head?.sha ?? null, head?.baseSnapshot ?? null, force),
    finishedAt: at,
    newSnapshot,
    baseline: head !== undefined && head.baseSnapshot === null,
    outcome: "failed",
    filesChanged: prev?.files_changed ?? 0,
    durationMs: Date.parse(at) - Date.parse(startedAt),
    problems: [errorText(err)],
  });
  await recordRunState(db, "failed", at, false);
}
