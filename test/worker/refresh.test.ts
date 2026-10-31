import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import corpus from "../fixtures/corpus.json";
import { runRefresh, type RunSummary, type StepRunner } from "../../src/refresh/run";
import { getPage, getPageSections, getSnapshotInfo } from "../../src/store/read";
import { FakeGitHub } from "./fake-github";

const db = env.DB;
const all = (corpus as { files: Record<string, string> }).files;
const NOW = new Date("2026-10-31T12:00:00.000Z");
const SLOW = 120_000;

const CHANNEL = "developers/resources/channel.mdx";
const GUILD = "developers/resources/guild.mdx";
const SONY = "snippets/discord-social-sdk/callouts/sony.mdx";
const SONY_IMPORTERS = [
  "discord-social-sdk/core-concepts/communication-features",
  "discord-social-sdk/core-concepts/platform-compatibility",
  "discord-social-sdk/design-guidelines/consoles",
];

/** Files the refresh must never download. */
const NOT_SELECTED = { "images/logo.png": "png bytes", "snippets/linkbutton.jsx": "export const LinkButton = () => null;", "README.md": "# readme" };

/**
 * A subset of the pinned corpus (docs.json, every snippet, 30 pages incl. the snippet importers) keeps each
 * baseline at a couple of seconds; 30 pages still span two parse chunks. One test runs the full corpus.
 */
const SUBSET_PAGES = new Set([
  CHANNEL,
  GUILD,
  "developers/resources/user.mdx",
  "developers/platform/bots.mdx",
  "developers/intro.mdx",
  ...SONY_IMPORTERS.map((p) => `developers/${p}.mdx`),
  ...Object.keys(all)
    .filter((k) => k.startsWith("developers/") && k !== "developers/change-log.mdx")
    .sort()
    .slice(0, 22),
]);
const subset = Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith("developers/") || SUBSET_PAGES.has(k)));
const subsetPageCount = Object.keys(subset).filter((k) => k.startsWith("developers/")).length;

const editedChannel = all[CHANNEL].replace("Get a channel by ID.", "Get a channel by its ID (edited in a test).");

const TABLES = [
  "snapshots", "file_contents", "snapshot_files", "pages", "sections", "sections_fts", "section_anchors", "endpoints",
  "objects", "fields", "enums", "enum_keys", "redirects", "changelog_entries", "runs", "change_records",
];

let gh: FakeGitHub;
let firstSha: string;
let deps: Parameters<typeof runRefresh>[0];
const direct: StepRunner = { do: (_name, fn) => fn() };

function setup(files: Record<string, string>): void {
  gh = new FakeGitHub({ ...files, ...NOT_SELECTED });
  firstSha = gh.head;
  deps = { db, source: gh, splitChars: 6000, now: () => NOW };
}

let logSpy: MockInstance<typeof console.log>;
beforeEach(async () => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("UPDATE refresh_state SET current_snapshot=NULL, last_success_at=NULL, last_run_at=NULL, last_run_outcome=NULL").run();
  setup(subset);
});

const count = async (table: string, where = "1=1", ...args: unknown[]) =>
  ((await db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${where}`).bind(...args).first()) as { c: number }).c;
const state = async () => (await db.prepare("SELECT * FROM refresh_state").first()) as Record<string, any>;
const run = async (id: string) => (await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first()) as Record<string, any> | null;
const status = async (id: number) => ((await db.prepare("SELECT status FROM snapshots WHERE id = ?").bind(id).first()) as { status: string }).status;
const current = async () => (await state()).current_snapshot as number;
const rawCalls = () => gh.calls.filter((c) => c.startsWith("raw:"));
const records = async (runId: string) =>
  (await db.prepare("SELECT * FROM change_records WHERE run_id = ? ORDER BY section_id").bind(runId).all<Record<string, any>>()).results;

async function baseline(): Promise<RunSummary> {
  const s = await runRefresh(deps, { runId: "r1", force: false }, direct);
  gh.calls.length = 0;
  return s;
}

describe("runRefresh", () => {
  it("first run is a baseline with no change records (full corpus)", { timeout: SLOW }, async () => {
    setup(all);
    const s = await runRefresh(deps, { runId: "r1", force: false }, direct);
    expect(s).toMatchObject({ outcome: "published", baseline: true, commitSha: firstSha });
    expect(await count("change_records")).toBe(0);
    const pages = Object.keys(all).filter((k) => k.startsWith("developers/")).length;
    expect(await count("pages", "snapshot_id = ?", await current())).toBe(pages);
    expect(await count("redirects", "snapshot_id = ?", await current())).toBeGreaterThan(0);
    // only selected files are downloaded, each distinct blob once, pinned to the commit
    const selected = Object.keys(all).length;
    expect(s.filesChanged).toBe(selected);
    expect(rawCalls()).toHaveLength(new Set(Object.values(all)).size);
    expect(rawCalls().every((c) => c.startsWith(`raw:${firstSha}:`))).toBe(true);
    for (const p of Object.keys(NOT_SELECTED)) expect(gh.calls.some((c) => c.endsWith(`:${p}`))).toBe(false);
  });

  it("no-op when head SHA unchanged", { timeout: SLOW }, async () => {
    await baseline();
    expect((await runRefresh(deps, { runId: "r2", force: false }, direct)).outcome).toBe("noop");
    expect(rawCalls()).toEqual([]);
    expect(gh.calls).toEqual(["head"]);
    expect(await count("snapshots")).toBe(1);
  });

  it("no-op confirms freshness: updates last_success_at and records the run", { timeout: SLOW }, async () => {
    await baseline();
    await db.prepare("UPDATE refresh_state SET last_success_at = '2026-10-01T00:00:00.000Z'").run();
    const s = await runRefresh(deps, { runId: "r2", force: false }, direct);
    expect(s).toEqual({ outcome: "noop", commitSha: firstSha, baseline: false, filesChanged: 0, sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: 0 });
    expect(await state()).toMatchObject({ last_success_at: NOW.toISOString(), last_run_at: NOW.toISOString(), last_run_outcome: "noop" });
    expect((await getSnapshotInfo(db, NOW, 72))!.stale).toBe(false);
    expect(await run("r2")).toMatchObject({ outcome: "noop", commit_sha: firstSha, new_snapshot: null, base_snapshot: await current(), files_changed: 0 });
  });

  it("incremental: downloads only the changed file, records section changes", { timeout: SLOW }, async () => {
    await baseline();
    const base = await current();
    // cleanup removes the retired base snapshot after the publish, so read what the comparison needs first
    const guildHashes = (await getPageSections(db, base, "resources/guild")).map((x) => x.contentHash);
    const baseRedirects = await count("redirects", "snapshot_id = ?", base);
    const sha = gh.commit({ [CHANNEL]: editedChannel });
    gh.calls.length = 0;
    const s = await runRefresh(deps, { runId: "r2", force: false }, direct);
    expect(rawCalls()).toEqual([`raw:${sha}:${CHANNEL}`]);
    expect(s).toMatchObject({ outcome: "published", baseline: false, commitSha: sha, filesChanged: 1, sectionsAdded: 0, sectionsRemoved: 0 });
    expect(s.sectionsModified).toBeGreaterThan(0);
    const recs = await records("r2");
    expect(recs).toHaveLength(s.sectionsModified);
    expect(recs).toContainEqual({
      run_id: "r2",
      commit_sha: sha,
      date: "2026-10-31",
      section_id: "resources/channel#get-channel",
      heading: "Get Channel",
      url: "https://docs.discord.com/developers/resources/channel#get-channel",
      change_type: "modified",
    });
    // unchanged pages were copied: same sections as before
    const id = await current();
    expect(id).not.toBe(base);
    expect(await count("pages", "snapshot_id = ?", id)).toBe(subsetPageCount);
    expect(guildHashes.length).toBeGreaterThan(0);
    expect((await getPageSections(db, id, "resources/guild")).map((x) => x.contentHash)).toEqual(guildHashes);
    expect(baseRedirects).toBeGreaterThan(0);
    expect(await count("redirects", "snapshot_id = ?", id)).toBe(baseRedirects);
  });

  it("changed snippet re-parses its importers", { timeout: SLOW }, async () => {
    await baseline();
    const sha = gh.commit({ [SONY]: all[SONY].replace("Sony Platforms", "Sony Platforms (snippet edited)") });
    gh.calls.length = 0;
    const s = await runRefresh(deps, { runId: "r2", force: false }, direct);
    expect(rawCalls()).toEqual([`raw:${sha}:${SONY}`]);
    expect(s.filesChanged).toBe(1);
    const pages = new Set((await records("r2")).map((r) => (r.section_id as string).split("#")[0]));
    expect([...pages].sort()).toEqual([...SONY_IMPORTERS].sort());
    for (const p of SONY_IMPORTERS) {
      const md = (await getPageSections(db, await current(), p)).map((x) => x.markdown).join("\n");
      expect(md).toContain("snippet edited");
    }
  });

  it("removed and re-added snippet re-parses importers (missing snippet is tracked via problems)", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [SONY]: null });
    await runRefresh(deps, { runId: "r2", force: false }, direct);
    const page = (await getPage(db, await current(), SONY_IMPORTERS[0]))!;
    expect(page.problems).toContain(`missing snippet: ${SONY}`);
    expect(page.snippetDeps).not.toContain(SONY);
    const sha = gh.commit({ [SONY]: all[SONY] });
    gh.calls.length = 0;
    await runRefresh(deps, { runId: "r3", force: false }, direct);
    expect(rawCalls()).toEqual([`raw:${sha}:${SONY}`]); // cleanup dropped the unreferenced blob, so it is fetched again
    const again = (await getPage(db, await current(), SONY_IMPORTERS[0]))!;
    expect(again.snippetDeps).toContain(SONY);
    expect(again.problems).not.toContain(`missing snippet: ${SONY}`);
  });

  it("docs.json change re-derives all pages", { timeout: SLOW }, async () => {
    await baseline();
    const sha = gh.commit({ "docs.json": all["docs.json"].replace('"App Fundamentals"', '"App Basics"') });
    gh.calls.length = 0;
    const s = await runRefresh(deps, { runId: "r2", force: false }, direct);
    expect(rawCalls()).toEqual([`raw:${sha}:docs.json`]);
    expect(s).toMatchObject({ outcome: "published", filesChanged: 1, sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: 0 });
    expect((await getPage(db, await current(), "platform/bots"))!.breadcrumb).toContain("App Basics");
  });

  it("removed page is gone from the new snapshot and its sections are recorded as removed", { timeout: SLOW }, async () => {
    await baseline();
    const base = await current();
    const baseIds = await count("sections", "snapshot_id = ? AND page_path = 'resources/guild' AND part = 1", base);
    expect(baseIds).toBeGreaterThan(0);
    gh.commit({ [GUILD]: null });
    const s = await runRefresh(deps, { runId: "r2", force: false }, direct);
    const id = await current();
    expect(await getPage(db, id, "resources/guild")).toBeNull();
    expect(await count("sections", "snapshot_id = ? AND page_path = 'resources/guild'", id)).toBe(0);
    expect(await count("snapshot_files", "snapshot_id = ? AND path = ?", id, GUILD)).toBe(0);
    expect(s).toMatchObject({ filesChanged: 1, sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: baseIds });
    expect((await records("r2")).every((r) => r.change_type === "removed" && (r.section_id as string).startsWith("resources/guild"))).toBe(true);
  });

  it("failed download leaves the previous snapshot readable", { timeout: SLOW }, async () => {
    await baseline();
    const base = await current();
    gh.commit({ [GUILD]: "x" });
    gh.failRaw = true;
    await expect(runRefresh(deps, { runId: "r2", force: false }, direct)).rejects.toThrow(`github raw 503 ${GUILD}`);
    const info = await getSnapshotInfo(db, new Date(), 72);
    expect(info!.commitSha).toBe(firstSha);
    expect(info!.id).toBe(base);
    expect((await db.prepare("SELECT last_run_outcome FROM refresh_state").first())!.last_run_outcome).toBe("failed");
    const r = (await run("r2"))!;
    expect(r).toMatchObject({ outcome: "failed", base_snapshot: base, forced: 0, baseline: 0 });
    expect(JSON.parse(r.problems)).toEqual([`github raw 503 ${GUILD}`]);
    expect(await status(r.new_snapshot)).toBe("failed");
    expect(await status(base)).toBe("live");
  });

  it("overlapping runs: only one publishes", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [CHANNEL]: editedChannel });
    const [a, b] = await Promise.allSettled([
      runRefresh(deps, { runId: "a", force: false }, direct),
      runRefresh(deps, { runId: "b", force: true }, direct),
    ]);
    const outcomes = [a, b].map((r) => (r.status === "fulfilled" ? r.value.outcome : "failed"));
    expect(outcomes.filter((o) => o === "published")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "lost-race")).toHaveLength(1);
  });

  it("lost race returns 'lost-race', marks only the loser's snapshot failed and keeps the winner's state", { timeout: SLOW }, async () => {
    await baseline();
    const base = await current();
    gh.commit({ [CHANNEL]: editedChannel });
    const names: string[] = [];
    let winner: RunSummary | undefined;
    const racing: StepRunner = {
      async do(name, fn) {
        names.push(name);
        if (name === "publish" && !winner) winner = await runRefresh(deps, { runId: "winner", force: true }, direct);
        return fn();
      },
    };
    const s = await runRefresh(deps, { runId: "loser", force: false }, racing);
    expect(winner!.outcome).toBe("published");
    expect(s).toMatchObject({ outcome: "lost-race", sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: 0 });
    const loser = (await run("loser"))!;
    expect(loser).toMatchObject({ outcome: "lost-race", base_snapshot: base });
    expect(await status(loser.new_snapshot)).toBe("failed");
    const won = (await run("winner"))!;
    expect(await current()).toBe(won.new_snapshot);
    expect(await status(won.new_snapshot)).toBe("live");
    expect(await state()).toMatchObject({ last_run_outcome: "published" });
    expect(await count("change_records", "run_id = 'loser'")).toBe(0);
    expect(names).not.toContain("cleanup");
    expect(names).not.toContain("record-failure");
  });

  it("publish step retried after a committed publish is treated as published", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [CHANNEL]: editedChannel });
    const retryPublish: StepRunner = {
      async do(name, fn) {
        if (name === "publish") await fn(); // first attempt commits, then "the step result is lost"
        return fn();
      },
    };
    const s = await runRefresh(deps, { runId: "r2", force: false }, retryPublish);
    expect(s.outcome).toBe("published");
    expect(s.sectionsModified).toBeGreaterThan(0);
    expect(await count("change_records", "run_id = 'r2'")).toBe(s.sectionsModified);
    const r = (await run("r2"))!;
    expect(r.outcome).toBe("published");
    expect(await current()).toBe(r.new_snapshot);
    expect(await status(r.new_snapshot)).toBe("live");
  });

  it("every step body is idempotent (each runs twice)", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [CHANNEL]: editedChannel, [GUILD]: null });
    const twice: StepRunner = {
      async do(_name, fn) {
        await fn();
        return fn();
      },
    };
    const s = await runRefresh(deps, { runId: "r2", force: false }, twice);
    expect(s.outcome).toBe("published");
    expect(await count("snapshots")).toBe(1); // base was retired and cleaned up; no orphan from the retried fetch-tree
    expect(await count("change_records", "run_id = 'r2'")).toBe(s.sectionsModified + s.sectionsRemoved);
    expect(await count("pages", "snapshot_id = ?", await current())).toBe(subsetPageCount - 1);
  });

  it("force on unchanged commit re-parses without change records", { timeout: SLOW }, async () => {
    await baseline();
    const base = await current();
    const baseSections = await count("sections", "snapshot_id = ?", base);
    const s = await runRefresh(deps, { runId: "r2", force: true }, direct);
    expect(s).toEqual({ outcome: "published", commitSha: firstSha, baseline: false, filesChanged: 0, sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: 0 });
    expect(rawCalls()).toEqual([]); // every blob is already in file_contents
    expect(await count("change_records")).toBe(0);
    const id = await current();
    expect(id).not.toBe(base);
    expect(await count("sections", "snapshot_id = ?", id)).toBe(baseSections);
  });

  it("force on unchanged commit records no change records even when the parser output differs", { timeout: SLOW }, async () => {
    await baseline();
    const base = await current();
    const baseSections = await count("sections", "snapshot_id = ?", base);
    // a smaller split threshold stands in for a parser change: the forced run's sections differ from the base's
    const s = await runRefresh({ ...deps, splitChars: 1500 }, { runId: "r2", force: true }, direct);
    expect(s).toMatchObject({ outcome: "published", baseline: false, sectionsAdded: 0, sectionsModified: 0, sectionsRemoved: 0 });
    expect(await count("sections", "snapshot_id = ?", await current())).not.toBe(baseSections);
    expect(await count("change_records")).toBe(0);
  });

  it("writes a runs row per outcome", { timeout: SLOW }, async () => {
    await baseline();
    const r1 = (await run("r1"))!;
    expect(r1).toMatchObject({
      outcome: "published",
      commit_sha: firstSha,
      base_snapshot: null,
      baseline: 1,
      forced: 0,
      files_changed: Object.keys(subset).length,
      sections_added: 0,
      sections_modified: 0,
      sections_removed: 0,
      started_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
      duration_ms: 0,
    });
    expect(await current()).toBe(r1.new_snapshot);
    expect(Array.isArray(JSON.parse(r1.problems))).toBe(true);
    expect(await state()).toMatchObject({ last_run_outcome: "published", last_run_at: NOW.toISOString() });

    const sha = gh.commit({ [CHANNEL]: editedChannel });
    const s = await runRefresh(deps, { runId: "r2", force: true }, direct);
    expect((await run("r2"))!).toMatchObject({
      outcome: "published",
      commit_sha: sha,
      base_snapshot: r1.new_snapshot,
      baseline: 0,
      forced: 1,
      files_changed: 1,
      sections_added: s.sectionsAdded,
      sections_modified: s.sectionsModified,
      sections_removed: s.sectionsRemoved,
    });
    expect(s.sectionsModified).toBeGreaterThan(0);
  });

  it("logs JSON lines with run ids, commit, step names, counts and durations only", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [GUILD]: "x" });
    gh.failRaw = true;
    await expect(runRefresh(deps, { runId: "r2", force: false }, direct)).rejects.toThrow();
    const lines = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.map((l) => l.event)).toEqual(expect.arrayContaining(["refresh.step", "refresh.done", "refresh.failed"]));
    const allowed = new Set(["event", "runId", "commitSha", "step", "outcome", "durationMs", "files", "downloads", "parse", "copy", "pages", "sections",
      "filesChanged", "sectionsAdded", "sectionsModified", "sectionsRemoved", "error"]);
    for (const l of lines) for (const k of Object.keys(l)) expect(allowed).toContain(k);
    const failed = lines.find((l) => l.event === "refresh.failed")!;
    expect(failed.error).toBe(`github raw 503 ${GUILD}`);
  });

  it("logs the error text when cleanup fails after a publish, and the run still succeeds", { timeout: SLOW }, async () => {
    const failingCleanup: StepRunner = { do: (name, fn) => (name === "cleanup" ? Promise.reject(new Error("cleanup boom\nsecond line")) : fn()) };
    const s = await runRefresh(deps, { runId: "r1", force: false }, failingCleanup);
    expect(s.outcome).toBe("published");
    const lines = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.find((l) => l.event === "refresh.cleanup_failed")).toMatchObject({ runId: "r1", error: "cleanup boom" });
  });

  it("logs the error text when recording a failure itself fails", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [GUILD]: "x" });
    gh.failRaw = true;
    const failingRecord: StepRunner = { do: (name, fn) => (name === "record-failure" ? Promise.reject(new Error("record boom")) : fn()) };
    await expect(runRefresh(deps, { runId: "r2", force: false }, failingRecord)).rejects.toThrow(`github raw 503 ${GUILD}`);
    const lines = logSpy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(lines.find((l) => l.event === "refresh.record_failure_failed")).toMatchObject({ runId: "r2", error: "record boom" });
  });

  it("calls only the stable step names, each once", { timeout: SLOW }, async () => {
    const names: string[] = [];
    const recording: StepRunner = { do: (name, fn) => (names.push(name), fn()) };
    await runRefresh(deps, { runId: "r1", force: false }, recording);
    const fetches = names.filter((n) => n.startsWith("fetch:"));
    expect(names.filter((n) => !n.startsWith("fetch:"))).toEqual(["resolve-head", "fetch-tree", "parse:0", "parse:1", "copy-unchanged", "publish", "cleanup"]);
    expect(fetches).toContain(`fetch:${CHANNEL}@${gh.blobSha(CHANNEL)}`);
    expect(fetches).toHaveLength(new Set(Object.values(subset)).size); // identical contents share a blob
    expect(new Set(names).size).toBe(names.length);

    names.length = 0;
    gh.commit({ [CHANNEL]: editedChannel });
    await runRefresh(deps, { runId: "r2", force: false }, recording);
    expect(names).toEqual(["resolve-head", "fetch-tree", `fetch:${CHANNEL}@${gh.blobSha(CHANNEL)}`, "parse:0", "copy-unchanged", "publish", "cleanup"]);

    names.length = 0;
    gh.commit({ [GUILD]: "x" });
    gh.failRaw = true;
    await expect(runRefresh(deps, { runId: "r3", force: false }, recording)).rejects.toThrow();
    expect(names).toEqual(["resolve-head", "fetch-tree", `fetch:${GUILD}@${gh.blobSha(GUILD)}`, "record-failure"]);

    names.length = 0;
    gh.failRaw = false;
    gh.commit({ [GUILD]: all[GUILD] }); // back to the live tree's content
    await runRefresh(deps, { runId: "r4", force: false }, recording);
    names.length = 0;
    await runRefresh(deps, { runId: "r5", force: false }, recording);
    expect(names).toEqual(["resolve-head"]);
  });

  it("record-failure failing does not mask the original error", { timeout: SLOW }, async () => {
    await baseline();
    gh.commit({ [GUILD]: "x" });
    gh.failRaw = true;
    const breaking: StepRunner = {
      do: (name, fn) => (name === "record-failure" ? Promise.reject(new Error("d1 down")) : fn()),
    };
    await expect(runRefresh(deps, { runId: "r2", force: false }, breaking)).rejects.toThrow(`github raw 503 ${GUILD}`);
    expect((await getSnapshotInfo(db, NOW, 72))!.commitSha).toBe(firstSha);
  });
});
