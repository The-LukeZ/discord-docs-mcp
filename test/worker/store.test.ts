import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import corpus from "../fixtures/corpus.json";
import { parseNavigation } from "../../src/parse/navigation";
import { parsePage, type ParsedPage } from "../../src/parse/page";
import {
  cleanup,
  copyPages,
  createSnapshot,
  publishSnapshot,
  writeFileContents,
  writePages,
  writeRedirects,
  writeSnapshotFiles,
} from "../../src/store/write";
import {
  counts,
  findEndpoints,
  findEnums,
  findObject,
  getPage,
  getPageSections,
  getSectionsByBaseId,
  getSnapshotInfo,
  listChangeRecords,
  listChangelog,
  resolveAnchor,
  resolveRedirect,
} from "../../src/store/read";

const db = env.DB;
const files = (corpus as { files: Record<string, string> }).files;
const now = new Date("2026-10-31T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();

const PATHS = ["developers/resources/channel.mdx", "developers/resources/user.mdx", "developers/change-log.mdx"];
let pages: ParsedPage[] = [];
const blobs = new Map<string, string>();
let channel: ParsedPage;

beforeAll(async () => {
  const snippets = new Map(Object.entries(files).filter(([k]) => k.startsWith("snippets/")));
  const ctx = { snippets, nav: parseNavigation(files["docs.json"]), splitChars: 6000 };
  pages = [];
  for (const p of PATHS) pages.push(await parsePage({ path: p, content: files[p] }, ctx));
  pages.forEach((p, i) => blobs.set(p.meta.path, `blob${i}`));
  channel = pages[0];
}, 120_000);

const TABLES = [
  "snapshots", "file_contents", "snapshot_files", "pages", "sections", "sections_fts", "section_anchors", "endpoints",
  "objects", "fields", "enums", "enum_keys", "redirects", "changelog_entries", "runs", "change_records",
];
beforeEach(async () => {
  for (const t of TABLES) await db.prepare(`DELETE FROM ${t}`).run();
  await db.prepare("UPDATE refresh_state SET current_snapshot=NULL, last_success_at=NULL").run();
});

const n = async (sql: string, ...args: unknown[]) => ((await db.prepare(sql).bind(...args).first()) as { c: number }).c;
const status = async (id: number) => ((await db.prepare("SELECT status FROM snapshots WHERE id=?").bind(id).first()) as { status: string }).status;

async function built(sha: string, subset: ParsedPage[] = pages): Promise<number> {
  const id = await createSnapshot(db, sha);
  await writePages(db, id, subset, blobs);
  return id;
}

describe("publish", () => {
  it("readers see nothing until publish, then the full snapshot", async () => {
    const id = await built("sha1");
    expect(await status(id)).toBe("building");
    expect(await getSnapshotInfo(db, now, 72)).toBeNull();
    expect(await publishSnapshot(db, id, null)).toBe(true);
    const info = (await getSnapshotInfo(db, now, 72))!;
    expect(info.commitSha).toBe("sha1");
    expect(info.id).toBe(id);
    expect(await status(id)).toBe("live");
  });

  it("CAS publish fails when the pointer moved; new stays non-live, old stays live", async () => {
    const a = await built("a", [channel]);
    expect(await publishSnapshot(db, a, null)).toBe(true);
    const b = await built("b", [channel]);
    expect(await publishSnapshot(db, b, 999)).toBe(false);
    expect((await getSnapshotInfo(db, now, 72))!.commitSha).toBe("a");
    expect(await status(b)).toBe("building");
    expect(await status(a)).toBe("live");
    // also fails when expecting null but a snapshot is current
    expect(await publishSnapshot(db, b, null)).toBe(false);
    expect(await status(b)).toBe("building");
  });

  it("publishing over a current snapshot retires the old one", async () => {
    const a = await built("a", [channel]);
    await publishSnapshot(db, a, null);
    const b = await built("b", [channel]);
    expect(await publishSnapshot(db, b, a)).toBe(true);
    expect(await status(a)).toBe("retired");
    expect(await status(b)).toBe("live");
    expect((await getSnapshotInfo(db, now, 72))!.id).toBe(b);
  });

  it("stale is true after 72h", async () => {
    const id = await built("s", [channel]);
    await publishSnapshot(db, id, null);
    await db.prepare("UPDATE refresh_state SET last_success_at=?").bind(hoursAgo(73)).run();
    expect((await getSnapshotInfo(db, now, 72))!.stale).toBe(true);
    await db.prepare("UPDATE refresh_state SET last_success_at=?").bind(hoursAgo(71)).run();
    const info = (await getSnapshotInfo(db, now, 72))!;
    expect(info.stale).toBe(false);
    expect(info.indexedAt).toBe(hoursAgo(71));
  });
});

describe("writePages + readers", () => {
  it("round-trips sections, page, entities and changelog", async () => {
    const id = await built("w");
    const p = (await getPage(db, id, "resources/channel"))!;
    expect(p.title).toBe(channel.meta.title);
    expect(p.url).toBe(channel.meta.url);
    expect(p.breadcrumb).toEqual(channel.meta.breadcrumb);
    expect(p.blobSha).toBe("blob0");
    expect(await getPage(db, id, "nope")).toBeNull();

    const secs = await getPageSections(db, id, "resources/channel");
    expect(secs.map((s) => s.id)).toEqual(channel.sections.map((s) => s.id));
    expect(secs[0].headingPath).toEqual(channel.sections[0].headingPath);
    expect(secs[0].markdown).toBe(channel.sections[0].markdown);

    const longBase = channel.sections.find((s) => s.part === 2)?.baseId;
    if (longBase) {
      const parts = await getSectionsByBaseId(db, id, longBase);
      expect(parts.map((s) => s.part)).toEqual(parts.map((_, i) => i + 1));
    }

    const ep = channel.endpoints[0];
    const found = await findEndpoints(db, id, { name: ep.name.toUpperCase() });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toMatchObject({ method: ep.method, pathTemplate: ep.pathTemplate, sectionId: ep.sectionId });
    expect(found[0].params).toEqual(ep.params);
    expect((await findEndpoints(db, id, { normalizedPath: ep.normalizedPath })).length).toBeGreaterThan(0);

    const obj = channel.objects[0];
    const o = (await findObject(db, id, obj.name.toLowerCase()))!;
    expect(o.sectionId).toBe(obj.sectionId);
    expect(o.fields).toEqual(obj.fields);
    expect(await findObject(db, id, "NoSuchObject")).toBeNull();
    expect(await n("SELECT count(*) c FROM fields WHERE snapshot_id=?", id)).toBe(
      pages.reduce((a, x) => a + x.objects.reduce((b, y) => b + y.fields.length, 0), 0),
    );

    const en = channel.enums[0];
    expect((await findEnums(db, id, { name: en.name })).map((e) => e.sectionId)).toContain(en.sectionId);
    const keyCell = en.rows[0][0];
    expect((await findEnums(db, id, { key: keyCell })).length).toBeGreaterThan(0);
    expect(await findEnums(db, id, {})).toEqual([]);

    const log = pages[2].changelog;
    expect(log.length).toBeGreaterThan(10);
    const all = await listChangelog(db, id, "0000-01-01", 1000);
    expect(all.map((e) => e.id)).toEqual(log.map((e) => e.id));
    expect(all[0].tags).toEqual(log[0].tags);
    expect(all[0].links).toEqual(log[0].links);
    const since = log[2].date;
    expect((await listChangelog(db, id, since, 1000)).every((e) => e.date >= since)).toBe(true);
    expect(await listChangelog(db, id, "0000-01-01", 3)).toHaveLength(3);

    const c = await counts(db, id);
    expect(c.pages).toBe(3);
    expect(c.sections).toBe(pages.reduce((a, x) => a + x.sections.length, 0));
    expect(c.endpoints).toBe(pages.reduce((a, x) => a + x.endpoints.length, 0));
    expect(c.changelog).toBe(log.length);
  });

  it("indexes FTS rows with joined heading path, page title and markdown", async () => {
    const id = await built("fts", [channel]);
    const s = channel.sections.find((x) => x.headingPath.length > 1)!;
    const row = (await db
      .prepare("SELECT heading_path, title, body, area FROM sections_fts WHERE snapshot_id=? AND section_id=?")
      .bind(id, s.id)
      .first()) as any;
    expect(row.heading_path).toBe(s.headingPath.join(" > "));
    expect(row.title).toBe(channel.meta.title);
    expect(row.body).toBe(s.markdown);
    expect(row.area).toBe(s.area);
    expect(await n("SELECT count(*) c FROM sections_fts WHERE snapshot_id=?", id)).toBe(channel.sections.length);
  });

  it("is idempotent: writing the same pages twice leaves one copy", async () => {
    const id = await built("idem", [channel]);
    const before = await counts(db, id);
    const ftsBefore = await n("SELECT count(*) c FROM sections_fts WHERE snapshot_id=?", id);
    const anchorsBefore = await n("SELECT count(*) c FROM section_anchors WHERE snapshot_id=?", id);
    expect(anchorsBefore).toBeGreaterThan(0);
    await writePages(db, id, [channel], blobs);
    expect(await counts(db, id)).toEqual(before);
    expect(await n("SELECT count(*) c FROM sections_fts WHERE snapshot_id=?", id)).toBe(ftsBefore);
    expect(await n("SELECT count(*) c FROM section_anchors WHERE snapshot_id=?", id)).toBe(anchorsBefore);
  });

  it("readers are isolated per snapshot id", async () => {
    const a = await built("a", [channel]);
    const b = await built("b", [pages[1]]);
    expect((await counts(db, a)).pages).toBe(1);
    expect(await getPage(db, a, "resources/user")).toBeNull();
    expect(await getPage(db, b, "resources/channel")).toBeNull();
    expect(await getPageSections(db, b, "resources/channel")).toEqual([]);
    expect(await findObject(db, b, channel.objects[0].name)).toBeNull();
    expect(await listChangelog(db, a, "0000-01-01", 10)).toEqual([]);
  });

  it("writeRedirects + resolveRedirect", async () => {
    const id = await createSnapshot(db, "r");
    await writeRedirects(db, id, [
      { source: "old/page", destination: "new/page" },
      { source: "a", destination: "b" },
      { source: "b", destination: "c" },
    ]);
    expect(await resolveRedirect(db, id, "old/page")).toBe("new/page");
    expect(await resolveRedirect(db, id, "same/page")).toBe("same/page");
    expect(await resolveRedirect(db, id, "a")).toBe("c");
    const other = await createSnapshot(db, "r2");
    expect(await resolveRedirect(db, other, "old/page")).toBe("old/page");
  });
});

describe("resolveAnchor", () => {
  it("resolves H4-H6 ids and own anchors to the containing section; unknown is null", async () => {
    const id = await built("anc");
    const withSub = pages.flatMap((p) => p.sections).find((s) => s.subAnchors.length > 0)!;
    expect(withSub).toBeDefined();
    for (const a of withSub.subAnchors) expect(await resolveAnchor(db, id, withSub.pagePath, a)).toBe(withSub.id);
    const plain = channel.sections.find((s) => s.anchor !== "" && s.part === 1)!;
    expect(await resolveAnchor(db, id, plain.pagePath, plain.anchor)).toBe(plain.id);
    expect(await resolveAnchor(db, id, plain.pagePath, "no-such-anchor")).toBeNull();
    expect(await resolveAnchor(db, id, "no/such/page", plain.anchor)).toBeNull();
    // isolated per snapshot
    const empty = await createSnapshot(db, "empty");
    expect(await resolveAnchor(db, empty, plain.pagePath, plain.anchor)).toBeNull();
  });
});

describe("copyPages", () => {
  it("carries sections, FTS, entities, anchors and changelog forward", async () => {
    const from = await built("from");
    const to = await createSnapshot(db, "to");
    await copyPages(db, from, to, ["resources/channel", "change-log"]);
    const per = async (t: string, id: number) => n(`SELECT count(*) c FROM ${t} WHERE snapshot_id=?`, id);
    const expectSections = channel.sections.length + pages[2].sections.length;
    expect(await per("sections", to)).toBe(expectSections);
    expect(await per("sections_fts", to)).toBe(expectSections);
    expect(await per("pages", to)).toBe(2);
    expect(await per("endpoints", to)).toBe(channel.endpoints.length);
    expect(await per("objects", to)).toBe(channel.objects.length);
    expect(await per("enums", to)).toBe(channel.enums.length);
    expect(await per("changelog_entries", to)).toBe(pages[2].changelog.length);
    const expectAnchors = await n(
      "SELECT count(*) c FROM section_anchors WHERE snapshot_id=? AND page_path IN ('resources/channel','change-log')",
      from,
    );
    expect(expectAnchors).toBeGreaterThan(0);
    expect(await per("section_anchors", to)).toBe(expectAnchors);
    // untouched page not copied
    expect(await getPage(db, to, "resources/user")).toBeNull();
    // anchors resolve in the copy
    const withSub = channel.sections.find((s) => s.subAnchors.length > 0);
    if (withSub) expect(await resolveAnchor(db, to, "resources/channel", withSub.subAnchors[0])).toBe(withSub.id);
    // FTS rows are searchable under the new snapshot id
    expect(await n("SELECT count(*) c FROM sections_fts WHERE snapshot_id=? AND sections_fts MATCH 'channel'", to)).toBeGreaterThan(0);
    // source untouched
    expect(await per("sections", from)).toBe(pages.reduce((a, x) => a + x.sections.length, 0));
  });

  it("copies many pages across statement chunks and is idempotent", async () => {
    const from = await built("from");
    const to = await createSnapshot(db, "to");
    const paths = [...Array.from({ length: 120 }, (_, i) => `ghost/${i}`), "resources/user"];
    await copyPages(db, from, to, paths);
    await copyPages(db, from, to, paths);
    expect(await n("SELECT count(*) c FROM sections WHERE snapshot_id=?", to)).toBe(pages[1].sections.length);
    expect(await n("SELECT count(*) c FROM sections_fts WHERE snapshot_id=?", to)).toBe(pages[1].sections.length);
    await copyPages(db, from, to, []);
  });
});

describe("snapshot files", () => {
  it("writeSnapshotFiles round-trips across batch boundaries", async () => {
    const id = await createSnapshot(db, "f");
    const list = Array.from({ length: 130 }, (_, i) => ({ path: `developers/p${i}.mdx`, blobSha: `sha${i}` }));
    await writeSnapshotFiles(db, id, list);
    await writeSnapshotFiles(db, id, list.slice(0, 5)); // retry-safe
    expect(await n("SELECT count(*) c FROM snapshot_files WHERE snapshot_id=?", id)).toBe(130);
    const row = (await db
      .prepare("SELECT blob_sha FROM snapshot_files WHERE snapshot_id=? AND path=?")
      .bind(id, "developers/p77.mdx")
      .first()) as any;
    expect(row.blob_sha).toBe("sha77");
    await writeSnapshotFiles(db, id, []);
  });

  it("writeFileContents is keyed by blob sha and ignores duplicates", async () => {
    await writeFileContents(db, [{ blobSha: "x", content: "one" }, { blobSha: "y", content: "two" }]);
    await writeFileContents(db, [{ blobSha: "x", content: "changed" }]);
    expect(await n("SELECT count(*) c FROM file_contents")).toBe(2);
    expect(((await db.prepare("SELECT content FROM file_contents WHERE blob_sha='x'").first()) as any).content).toBe("one");
  });
});

describe("cleanup", () => {
  it("removes retired/failed/stale-building snapshots, keeps live and recent building", async () => {
    const old = await built("old", [channel]);
    await writeSnapshotFiles(db, old, [{ path: "developers/resources/channel.mdx", blobSha: "gone" }]);
    await publishSnapshot(db, old, null);
    const live = await built("live", [pages[1]]);
    await writeSnapshotFiles(db, live, [{ path: "developers/resources/user.mdx", blobSha: "kept" }]);
    await writeRedirects(db, live, [{ source: "s", destination: "d" }]);
    await publishSnapshot(db, live, old);
    const failed = await built("failed", [channel]);
    await db.prepare("UPDATE snapshots SET status='failed' WHERE id=?").bind(failed).run();
    const staleBuilding = await built("stale", [channel]);
    await db.prepare("UPDATE snapshots SET created_at=? WHERE id=?").bind(hoursAgo(25), staleBuilding).run();
    const recentBuilding = await built("recent", [channel]);
    await db.prepare("UPDATE snapshots SET created_at=? WHERE id=?").bind(hoursAgo(2), recentBuilding).run();
    await writeSnapshotFiles(db, recentBuilding, [{ path: "developers/resources/channel.mdx", blobSha: "inflight" }]);
    await writeFileContents(db, [
      { blobSha: "gone", content: "g" },
      { blobSha: "kept", content: "k" },
      { blobSha: "inflight", content: "i" },
      { blobSha: "orphan", content: "o" },
    ]);

    await cleanup(db, now);

    const ids = ((await db.prepare("SELECT id FROM snapshots ORDER BY id").all()).results as any[]).map((r) => r.id);
    expect(ids).toEqual([live, recentBuilding]);
    for (const t of [
      "pages", "sections", "sections_fts", "section_anchors", "endpoints", "objects", "fields", "enums", "enum_keys",
      "changelog_entries", "snapshot_files", "redirects",
    ]) {
      const gone = await n(`SELECT count(*) c FROM ${t} WHERE snapshot_id IN (?,?,?)`, old, failed, staleBuilding);
      expect(gone, t).toBe(0);
    }
    expect(await n("SELECT count(*) c FROM sections WHERE snapshot_id=?", live)).toBe(pages[1].sections.length);
    expect(await n("SELECT count(*) c FROM sections_fts WHERE snapshot_id=?", live)).toBe(pages[1].sections.length);
    expect(await n("SELECT count(*) c FROM sections WHERE snapshot_id=?", recentBuilding)).toBe(channel.sections.length);
    expect(await n("SELECT count(*) c FROM redirects WHERE snapshot_id=?", live)).toBe(1);
    const blobsLeft = ((await db.prepare("SELECT blob_sha FROM file_contents ORDER BY blob_sha").all()).results as any[]).map((r) => r.blob_sha);
    expect(blobsLeft).toEqual(["inflight", "kept"]);
    expect((await getSnapshotInfo(db, now, 72))!.id).toBe(live);
  });

  it("never deletes the current snapshot even if its status is off", async () => {
    const id = await built("c", [channel]);
    await publishSnapshot(db, id, null);
    await db.prepare("UPDATE snapshots SET status='retired' WHERE id=?").bind(id).run();
    await cleanup(db, now);
    expect(await n("SELECT count(*) c FROM sections WHERE snapshot_id=?", id)).toBe(channel.sections.length);
  });

  it("drops change records older than 180 days and keeps newer", async () => {
    const ins = (run: string, date: string) =>
      db
        .prepare("INSERT INTO change_records (run_id, commit_sha, date, section_id, heading, url, change_type) VALUES (?, 'c', ?, 's', 'h', 'u', 'added')")
        .bind(run, date)
        .run();
    const day = (d: number) => new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10);
    await ins("old", day(181));
    await ins("edge", day(179));
    await ins("new", day(1));
    await cleanup(db, now);
    const left = ((await db.prepare("SELECT run_id FROM change_records ORDER BY run_id").all()).results as any[]).map((r) => r.run_id);
    expect(left).toEqual(["edge", "new"]);
    const listed = await listChangeRecords(db, day(30), 10);
    expect(listed.map((r) => r.runId)).toEqual(["new"]);
    expect(listed[0]).toMatchObject({ commitSha: "c", sectionId: "s", heading: "h", url: "u", changeType: "added" });
  });
});
