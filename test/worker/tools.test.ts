import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readConfig } from "../../src/config";
import { getSectionTool, lookupEndpointTool, lookupEnumTool, lookupObjectTool, recentChangesTool, searchDocsTool, type ToolResult } from "../../src/mcp/tools";
import { listChangelog } from "../../src/store/read";
import { indexCorpus } from "./corpus-index";

let sid = 0;
const cfg = readConfig(env);
beforeAll(async () => {
  sid = await indexCorpus(env.DB);
}, 120_000);

const DOCS = "https://docs.discord.com/developers/";
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const expectEnvelope = (r: ToolResult) => {
  expect(r.text).toContain("indexed_commit:");
  expect(r.text).toContain("indexed_at:");
  expect(r.text).toContain("Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.");
};

describe("no index", () => {
  it("empty index returns building error", async () => {
    const state = await env.DB.prepare("SELECT current_snapshot FROM refresh_state WHERE id = 1").first<{ current_snapshot: number }>();
    await env.DB.prepare("UPDATE refresh_state SET current_snapshot = NULL WHERE id = 1").run();
    try {
      for (const r of [
        await searchDocsTool(env.DB, cfg, { query: "x" }),
        await getSectionTool(env.DB, cfg, { section_id: "resources/channel#channel-object" }),
        await lookupEndpointTool(env.DB, cfg, { query: "Get Channel" }),
        await lookupObjectTool(env.DB, cfg, { name: "Channel" }),
        await lookupEnumTool(env.DB, cfg, { name: "Channel Types" }),
        await recentChangesTool(env.DB, cfg, {}),
      ]) {
        expect(r).toMatchObject({ isError: true });
        expect(r.text).toMatch(/being built/);
      }
    } finally {
      await env.DB.prepare("UPDATE refresh_state SET current_snapshot = ?1 WHERE id = 1").bind(state!.current_snapshot).run();
    }
  });

  it("a stale index adds the warning to every response", async () => {
    const state = await env.DB.prepare("SELECT last_success_at FROM refresh_state WHERE id = 1").first<{ last_success_at: string }>();
    const old = new Date(Date.now() - 100 * 3600_000).toISOString();
    await env.DB.prepare("UPDATE refresh_state SET last_success_at = ?1 WHERE id = 1").bind(old).run();
    try {
      const ok = await searchDocsTool(env.DB, cfg, { query: "Create Message" });
      expect(ok.text).toContain(`Warning: index is stale (last successful refresh ${old}).`);
      const err = await lookupObjectTool(env.DB, cfg, { name: "Nonexistent Thing" });
      expect(err.isError).toBe(true);
      expect(err.text).toContain("Warning: index is stale");
    } finally {
      await env.DB.prepare("UPDATE refresh_state SET last_success_at = ?1 WHERE id = 1").bind(state!.last_success_at).run();
    }
  });

  it("a fresh index has no stale warning", async () => {
    const r = await searchDocsTool(env.DB, cfg, { query: "Create Message" });
    expect(r.text).not.toContain("stale");
  });
});

describe("search_docs", () => {
  it("search results carry URLs and envelope", async () => {
    const r = await searchDocsTool(env.DB, cfg, { query: "Create Message" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("https://docs.discord.com/developers/");
    expect(r.text).toContain("indexed_commit:");
    expectEnvelope(r);
    expect(r.text).toContain("section_id: resources/message#create-message");
  });

  it("empty or blank query is a usage error with the envelope", async () => {
    for (const query of ["", "   ", "***"]) {
      const r = await searchDocsTool(env.DB, cfg, { query });
      expect(r.isError, query).toBe(true);
      expect(r.text, query).toMatch(/^Invalid input:/);
      expectEnvelope(r);
    }
    expect((await searchDocsTool(env.DB, cfg, {} as never)).isError).toBe(true);
  });

  it("limit defaults to 8 and clamps to 1..20", async () => {
    const n = (r: ToolResult) => count(r.text, /^\d+\. /gm);
    expect(n(await searchDocsTool(env.DB, cfg, { query: "channel" }))).toBe(8);
    expect(n(await searchDocsTool(env.DB, cfg, { query: "channel", limit: 3 }))).toBe(3);
    expect(n(await searchDocsTool(env.DB, cfg, { query: "channel", limit: 500 }))).toBe(20);
    expect(n(await searchDocsTool(env.DB, cfg, { query: "channel", limit: 0 }))).toBe(1);
    expect(n(await searchDocsTool(env.DB, cfg, { query: "channel", limit: -4 }))).toBe(1);
    expect(n(await searchDocsTool(env.DB, cfg, { query: "channel", limit: Number.NaN }))).toBe(8);
  });

  it("area filter applies", async () => {
    const r = await searchDocsTool(env.DB, cfg, { query: "GUILD_MEMBERS", area: "events" });
    const ids = [...r.text.matchAll(/section_id: (\S+)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("events/"))).toBe(true);
  });

  it("no hits is a clear non-error message", async () => {
    const r = await searchDocsTool(env.DB, cfg, { query: "qqqzzzxxxnonexistentword" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/No results/);
    expectEnvelope(r);
  });
});

describe("get_section", () => {
  it("get_section by legacy URL", async () => {
    const r = await getSectionTool(env.DB, cfg, { url: "https://discord.com/developers/docs/resources/channel#channel-object" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("rate_limit_per_user");
    expect(r.text).toContain(`${DOCS}resources/channel#channel-object`);
    expectEnvelope(r);
  });

  it("get_section by docs.discord.com URL with anchor", async () => {
    const r = await getSectionTool(env.DB, { ...cfg, responseCharCap: 1_000_000 }, { url: `${DOCS}resources/message#create-message` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Create Message");
  });

  it("get_section truncates with a working cursor", async () => {
    const small = { ...cfg, responseCharCap: 2000 };
    const r1 = await getSectionTool(env.DB, small, { section_id: "resources/channel#channel-object" });
    const cursor = r1.text.match(/cursor: (\S+)/)![1];
    const r2 = await getSectionTool(env.DB, small, { section_id: "resources/channel#channel-object", cursor });
    expect(r2.isError).toBe(false);
    expect(r2.text).not.toEqual(r1.text);
  });

  it("following cursors reassembles the whole section", async () => {
    const small = { ...cfg, responseCharCap: 3000 };
    const whole = await getSectionTool(env.DB, { ...cfg, responseCharCap: 1_000_000 }, { section_id: "resources/message#create-message" });
    expect(whole.text).not.toContain("cursor:");
    let cursor: string | undefined;
    let pages = 0;
    let seenAll = "";
    do {
      const r = await getSectionTool(env.DB, small, { section_id: "resources/message#create-message", cursor });
      expect(r.isError).toBe(false);
      expect(r.text).toContain(`${DOCS}resources/message#create-message`);
      seenAll += r.text;
      cursor = r.text.match(/^cursor: (\S+)$/m)?.[1];
      pages++;
      expect(pages).toBeLessThan(40);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    for (const needle of ["Create Message", "JSON/Form Params", "message_reference"]) expect(seenAll).toContain(needle);
  });

  it("the truncated response says so and stays near the cap", async () => {
    const small = { ...cfg, responseCharCap: 2000 };
    const r = await getSectionTool(env.DB, small, { section_id: "resources/channel#channel-object" });
    expect(r.text).toMatch(/Truncated/);
    expect(r.text.length).toBeLessThan(2000 + 1200);
  });

  it("a bare section id returns all parts joined, once-headed", async () => {
    const big = { ...cfg, responseCharCap: 1_000_000 };
    const r = await getSectionTool(env.DB, big, { section_id: "resources/channel#channel-object" });
    expect(r.isError).toBe(false);
    for (const needle of ["rate_limit_per_user", "GUILD_TEXT", "Channel Flags"]) expect(r.text).toContain(needle);
    expect(count(r.text, /^#{2,3} Channel Object$/gm)).toBe(1);
  });

  it("an explicit ~n id returns only that part", async () => {
    const big = { ...cfg, responseCharCap: 1_000_000 };
    const r = await getSectionTool(env.DB, big, { section_id: "resources/channel#channel-object~2" });
    expect(r.isError).toBe(false);
    expect(r.text).not.toContain("Channel Flags");
    const missing = await getSectionTool(env.DB, big, { section_id: "resources/channel#channel-object~99" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^Not found:/);
  });

  it("get_section page URL returns outline", async () => {
    const r = await getSectionTool(env.DB, cfg, { url: "https://docs.discord.com/developers/resources/channel" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("resources/channel#");
    expect(r.text).toContain("Outline");
    expect(r.text).toContain(`${DOCS}resources/channel`);
  });

  it("a page outline lists every heading and truncates with a cursor", async () => {
    const small = { ...cfg, responseCharCap: 1500 };
    const r = await getSectionTool(env.DB, small, { url: `${DOCS}resources/channel` });
    expect(r.text).toContain("resources/channel#get-channel");
    const cursor = r.text.match(/^cursor: (\S+)$/m)?.[1];
    expect(cursor).toBeDefined();
    const r2 = await getSectionTool(env.DB, small, { url: `${DOCS}resources/channel`, cursor });
    expect(r2.isError).toBe(false);
    expect(r2.text).not.toContain("Outline");
  });

  it("a bare page path as section_id gives the outline too", async () => {
    const r = await getSectionTool(env.DB, cfg, { section_id: "resources/channel" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Outline");
  });

  it("follows docs.json redirects", async () => {
    const r = await getSectionTool(env.DB, cfg, { url: `${DOCS}discord-social-sdk/development-guides/using-provisional-accounts` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("discord-social-sdk/development-guides/provisional-accounts/overview");
  });

  it("resolves an H4+ sub-anchor to its containing section", async () => {
    const row = await env.DB.prepare(
      "SELECT a.page_path, a.anchor, a.section_id FROM section_anchors a JOIN sections s ON s.snapshot_id = a.snapshot_id AND s.id = a.section_id WHERE a.snapshot_id = ?1 AND a.anchor <> s.anchor AND s.part = 1 AND s.anchor <> '' LIMIT 1",
    )
      .bind(sid)
      .first<{ page_path: string; anchor: string; section_id: string }>();
    expect(row).not.toBeNull();
    const r = await getSectionTool(env.DB, { ...cfg, responseCharCap: 1_000_000 }, { url: `${DOCS}${row!.page_path}#${row!.anchor}` });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`section_id: ${row!.section_id}`);
  });

  it("unknown section id returns suggestions", async () => {
    const r = await getSectionTool(env.DB, cfg, { section_id: "resources/channel#nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Not found:/);
    expect(r.text).toContain(DOCS);
    expectEnvelope(r);
    expect(count(r.text, /^- .*section_id: /gm)).toBeLessThanOrEqual(5);
    expect(count(r.text, /^- .*section_id: /gm)).toBeGreaterThan(0);
  });

  it("unknown page and non-docs URLs are Not found", async () => {
    for (const url of [`${DOCS}no/such/page`, "https://example.com/developers/resources/channel", "not a url", "https://docs.discord.com/other/x"]) {
      const r = await getSectionTool(env.DB, cfg, { url });
      expect(r.isError, url).toBe(true);
      expect(r.text, url).toMatch(/^Not found:/);
      expectEnvelope(r);
    }
  });

  it("empty section_id and url are a usage error", async () => {
    for (const input of [{}, { section_id: "" }, { section_id: "   " }, { url: "" }, { section_id: "", url: " " }, { cursor: "abc" }]) {
      const r = await getSectionTool(env.DB, cfg, input);
      expect(r.isError, JSON.stringify(input)).toBe(true);
      expect(r.text, JSON.stringify(input)).toMatch(/^Invalid input:/);
      expectEnvelope(r);
    }
  });

  it("a garbage cursor is an error", async () => {
    const r = await getSectionTool(env.DB, cfg, { section_id: "resources/channel#channel-object", cursor: "garbage" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cursor/i);
  });

  it("a cursor issued for another section is refused and leaks nothing", async () => {
    const small = { ...cfg, responseCharCap: 2000 };
    const r1 = await getSectionTool(env.DB, small, { section_id: "resources/channel#channel-object" });
    const cursor = r1.text.match(/^cursor: (\S+)$/m)![1];
    const r = await getSectionTool(env.DB, small, { section_id: "resources/message#create-message", cursor });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cursor/i);
    expect(r.text).not.toContain("JSON/Form Params");
    expect(r.text).not.toContain("rate_limit_per_user");
    expectEnvelope(r);
  });

  it("a cursor past the end of the section is an error", async () => {
    const { encodeCursor } = await import("../../src/mcp/format");
    const cursor = encodeCursor({ target: "resources/channel#channel-object", offset: 10_000_000 });
    const r = await getSectionTool(env.DB, cfg, { section_id: "resources/channel#channel-object", cursor });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/cursor/i);
  });
});

describe("lookup_endpoint", () => {
  it.each([
    "Get Channel Messages",
    "GET /channels/{channel.id}/messages",
    "get /channels/123/messages",
    "https://discord.com/api/v10/channels/123/messages?limit=5",
  ])("lookup_endpoint %s", async (q) => {
    const r = await lookupEndpointTool(env.DB, cfg, { query: q });
    expect(r.isError).toBe(false);
    expect(r.text.split("\n").slice(0, 5).join("\n")).toContain("Get Channel Messages");
  });

  it("renders method, path, description, param tables and URL", async () => {
    const r = await lookupEndpointTool(env.DB, cfg, { query: "Get Channel Messages" });
    expect(r.text).toContain("`GET /channels/{channel.id}/messages`");
    expect(r.text).toContain("Retrieves the messages in a channel");
    expect(r.text).toContain("Query String Params");
    expect(r.text).toContain("| around? | snowflake |");
    expect(r.text).toContain(`${DOCS}resources/message#get-channel-messages`);
    expectEnvelope(r);
  });

  it("method plus path narrows to one endpoint", async () => {
    const r = await lookupEndpointTool(env.DB, cfg, { query: "POST /channels/123/messages" });
    expect(r.text.split("\n").slice(0, 5).join("\n")).toContain("Create Message");
    expect(r.text.split("\n").slice(0, 5).join("\n")).not.toContain("Get Channel Messages");
  });

  it("adds up to 5 near matches that all own endpoints", async () => {
    const r = await lookupEndpointTool(env.DB, cfg, { query: "Get Channel Messages" });
    const near = r.text.split(/^## Near matches.*$/m)[1] ?? "";
    expect(count(near, /^- /gm)).toBeLessThanOrEqual(5);
  });

  it("falls back to near matches when nothing is exact", async () => {
    const r = await lookupEndpointTool(env.DB, cfg, { query: "channel messages" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Near matches");
    expect(r.text).toContain("Get Channel Messages");
  });

  it("unknown query is Not found with suggestions", async () => {
    const r = await lookupEndpointTool(env.DB, cfg, { query: "qqqzzz" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Not found:/);
    expectEnvelope(r);
    const p = await lookupEndpointTool(env.DB, cfg, { query: "GET /qqq/zzz" });
    expect(p.isError).toBe(true);
    expect(p.text).toMatch(/^Not found:/);
  });

  it("empty query, bare method and bare slash do not list everything", async () => {
    for (const query of ["", "   "]) {
      const r = await lookupEndpointTool(env.DB, cfg, { query });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Invalid input:/);
    }
    const m = await lookupEndpointTool(env.DB, cfg, { query: "GET" });
    expect(count(m.text, /^## /gm)).toBeLessThan(15);
  });
});

describe("lookup_object", () => {
  it("lookup_object Channel lists fields and related enums", async () => {
    const r = await lookupObjectTool(env.DB, cfg, { name: "channel" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("rate_limit_per_user");
    expect(r.text).toContain("Channel Types");
    expect(r.text).toContain(`${DOCS}resources/channel#channel-object`);
    expect(r.text).toContain("section_id: resources/channel#channel-object");
    expectEnvelope(r);
  });

  it("related enums are owned by the object or on its own page", async () => {
    const r = await lookupObjectTool(env.DB, cfg, { name: "channel" });
    for (const name of ["Channel Types", "Video Quality Modes", "Channel Flags", "Sort Order Types", "Forum Layout Types"]) expect(r.text).toContain(name);
    expect(r.text).not.toContain("Channel Pins Update Event Fields");
    expect(r.text).not.toContain("linked-channels");
  });

  it("strips a trailing Object or Structure from the query", async () => {
    for (const name of ["Channel Object", "channel structure", "CHANNEL OBJECT"]) {
      const r = await lookupObjectTool(env.DB, cfg, { name });
      expect(r.isError, name).toBe(false);
      expect(r.text, name).toContain("rate_limit_per_user");
    }
  });

  it("matches by tokens, shortest first", async () => {
    const r = await lookupObjectTool(env.DB, cfg, { name: "mention channel" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Channel Mention");
  });

  it("unknown name is Not found with suggestions", async () => {
    const r = await lookupObjectTool(env.DB, cfg, { name: "Zzzqqq Thing" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Not found:/);
    expectEnvelope(r);
  });

  it("empty name is a usage error", async () => {
    for (const name of ["", "  "]) {
      const r = await lookupObjectTool(env.DB, cfg, { name });
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/^(Invalid input|Not found):/);
    }
    expect((await lookupObjectTool(env.DB, cfg, { name: "" })).text).toMatch(/^Invalid input:/);
  });
});

describe("lookup_enum", () => {
  it("lookup_enum Permission Flags", async () => {
    const r = await lookupEnumTool(env.DB, cfg, { name: "Permission Flags" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("ADMINISTRATOR");
    expect(r.text).toContain("Bitwise Permission Flags");
    expect(r.text).toContain(`${DOCS}topics/permissions`);
    expectEnvelope(r);
  });

  it("does not return the channel type legend as a second permission table", async () => {
    const r = await lookupEnumTool(env.DB, cfg, { name: "Permission Flags" });
    expect(count(r.text, /^## Bitwise Permission Flags/gm)).toBe(1);
    expect(r.text).not.toContain("Abbreviated) | Description | Channel Types");
  });

  it("exact name keeps original columns and owner", async () => {
    const r = await lookupEnumTool(env.DB, cfg, { name: "channel types" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("GUILD_TEXT");
    expect(r.text).toMatch(/Owning object: Channel/);
    expect(r.text).toContain(`${DOCS}resources/channel#channel-object`);
  });

  it("keeps footnote markers of the raw rows", async () => {
    const r = await lookupEnumTool(env.DB, cfg, { name: "Bitwise Permission Flags" });
    expect(r.text).toContain("KICK_MEMBERS *");
  });

  it("an enum key falls back to the enums containing it", async () => {
    const r = await lookupEnumTool(env.DB, cfg, { name: "ADMINISTRATOR" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Bitwise Permission Flags");
  });

  it("unknown and empty names", async () => {
    const u = await lookupEnumTool(env.DB, cfg, { name: "Zzzqqq Flags" });
    expect(u.isError).toBe(true);
    expect(u.text).toMatch(/^Not found:/);
    for (const name of ["", "   "]) {
      const r = await lookupEnumTool(env.DB, cfg, { name });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Invalid input:/);
      expectEnvelope(r);
    }
  });

  it("a huge enum is cut at the cap with a pointer to get_section", async () => {
    const r = await lookupEnumTool(env.DB, { ...cfg, responseCharCap: 600 }, { name: "Bitwise Permission Flags" });
    expect(r.text).toMatch(/Truncated/);
    expect(r.text).toContain("get_section");
    expect(r.text.length).toBeLessThan(600 + 1000);
  });
});

describe("recent_changes", () => {
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM change_records").run();
  });

  it("recent_changes changelog", async () => {
    const r = await recentChangesTool(env.DB, cfg, { source: "changelog", since: "2000-01-01", limit: 3 });
    expect(r.isError).toBe(false);
    expect(count(r.text, /^- \*\*\d{4}-\d{2}-\d{2}\*\*/gm)).toBe(3);
    expect(r.text).toContain("https://docs.discord.com/developers/change-log#");
    expectEnvelope(r);
  });

  it("is newest first", async () => {
    const r = await recentChangesTool(env.DB, cfg, { source: "changelog", since: "2000-01-01", limit: 10 });
    const dates = [...r.text.matchAll(/^- \*\*(\d{4}-\d{2}-\d{2})\*\*/gm)].map((m) => m[1]);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("limit defaults to 20 and clamps to 100", async () => {
    const total = (await listChangelog(env.DB, sid, "2000-01-01", 1000)).length;
    const n = (r: ToolResult) => count(r.text, /^- \*\*\d{4}-\d{2}-\d{2}\*\*/gm);
    expect(total).toBeGreaterThan(20);
    expect(n(await recentChangesTool(env.DB, cfg, { source: "changelog", since: "2000-01-01" }))).toBe(20);
    expect(n(await recentChangesTool(env.DB, cfg, { source: "changelog", since: "2000-01-01", limit: 100000 }))).toBe(Math.min(total, 100));
    expect(n(await recentChangesTool(env.DB, cfg, { source: "changelog", since: "2000-01-01", limit: 0 }))).toBe(1);
  });

  it("default since is 30 days back: nothing from the year 2000 and an old entry is excluded", async () => {
    const r = await recentChangesTool(env.DB, cfg, { source: "changelog" });
    expect(r.isError).toBe(false);
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    for (const m of r.text.matchAll(/^- \*\*(\d{4}-\d{2}-\d{2})\*\*/gm)) expect(m[1] >= cutoff).toBe(true);
  });

  it("docs source lists section changes; both merges them", async () => {
    const ins = (id: string, date: string, type: string) =>
      env.DB.prepare("INSERT INTO change_records (run_id, commit_sha, date, section_id, heading, url, change_type) VALUES ('r1','c1',?1,?2,?3,?4,?5)").bind(
        date,
        id,
        "Create Message",
        `${DOCS}${id}`,
        type,
      );
    await env.DB.batch([ins("resources/message#create-message", "2026-10-30T00:00:00.000Z", "modified"), ins("resources/message#get-channel-messages", "2026-10-29T00:00:00.000Z", "added")]);
    const docs = await recentChangesTool(env.DB, cfg, { source: "docs", since: "2000-01-01" });
    expect(docs.isError).toBe(false);
    expect(docs.text).toContain("modified");
    expect(docs.text).toContain(`${DOCS}resources/message#create-message`);
    expect(docs.text).not.toContain("change-log#");
    const both = await recentChangesTool(env.DB, cfg, { since: "2000-01-01", limit: 5 });
    expect(both.text).toContain("change-log#");
    expect(both.text).toContain("resources/message#create-message");
    expect(count(both.text, /^- \*\*\d{4}-\d{2}-\d{2}\*\*/gm)).toBeLessThanOrEqual(5);
  });

  it("nothing in range is a clear non-error message", async () => {
    const r = await recentChangesTool(env.DB, cfg, { source: "docs", since: "2000-01-01" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/No .*changes/);
    expectEnvelope(r);
  });

  it("rejects a bad since or source", async () => {
    for (const input of [{ since: "yesterday" }, { since: "2026-13-45" }, { source: "bogus" }]) {
      const r = await recentChangesTool(env.DB, cfg, input as never);
      expect(r.isError, JSON.stringify(input)).toBe(true);
      expect(r.text, JSON.stringify(input)).toMatch(/^Invalid input:/);
      expectEnvelope(r);
    }
  });

  it("accepts a full ISO timestamp for since", async () => {
    const r = await recentChangesTool(env.DB, cfg, { source: "changelog", since: "2000-01-01T00:00:00Z", limit: 2 });
    expect(r.isError).toBe(false);
  });
});

describe("hostile input", () => {
  it.each(['"', "*", "NEAR(", "'; DROP TABLE sections; --", "\u0000", "x".repeat(5000)])("input %j does not throw", async (q) => {
    await expect(searchDocsTool(env.DB, cfg, { query: q })).resolves.toHaveProperty("text");
    await expect(lookupEndpointTool(env.DB, cfg, { query: q })).resolves.toHaveProperty("text");
    await expect(lookupObjectTool(env.DB, cfg, { name: q })).resolves.toHaveProperty("text");
    await expect(lookupEnumTool(env.DB, cfg, { name: q })).resolves.toHaveProperty("text");
    await expect(getSectionTool(env.DB, cfg, { section_id: q })).resolves.toHaveProperty("text");
    await expect(getSectionTool(env.DB, cfg, { url: q })).resolves.toHaveProperty("text");
  });
});
