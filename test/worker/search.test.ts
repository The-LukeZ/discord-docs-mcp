import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { searchDocs } from "../../src/search/search";
import { indexCorpus } from "./corpus-index";

let sid = 0;
beforeAll(async () => {
  sid = await indexCorpus(env.DB);
}, 120_000);

const search = (query: string, limit = 8, area?: string) => searchDocs(env.DB, sid, { query, limit, area });
const top3 = async (q: string) => (await search(q)).slice(0, 3);

describe("golden queries", () => {
  it("GUILD_MEMBERS -> Gateway Intents", async () =>
    expect((await top3("GUILD_MEMBERS")).some((h) => h.headingPath.join(" ").includes("Gateway Intents"))).toBe(true));

  it("rate_limit_per_user -> Channel Object", async () =>
    expect((await top3("rate_limit_per_user")).some((h) => h.sectionId.startsWith("resources/channel#channel-object"))).toBe(true));

  it("POST /channels/{channel.id}/messages -> Create Message", async () =>
    expect((await top3("POST /channels/{channel.id}/messages")).some((h) => h.headingPath.at(-1) === "Create Message")).toBe(true));

  it("interaction callback path", async () => {
    const hits = await top3("POST /interactions/{interaction.id}/{interaction.token}/callback");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].matchedOn).toBe("endpoint");
  });

  it("lowercase 'get channel' finds Get Channel at rank 1", async () => {
    const [first] = await search("get channel");
    expect(first.headingPath.at(-1)).toBe("Get Channel");
    expect(first.matchedOn).toBe("endpoint");
  });

  it("an endpoint hit carries url with anchor and a snippet", async () => {
    const [first] = await search("Get Channel");
    expect(first.url).toMatch(/^https:\/\/docs\.discord\.com\/developers\/resources\/channel#get-channel$/);
    expect(first.snippet.length).toBeGreaterThan(0);
    expect(first.snippet.length).toBeLessThanOrEqual(300);
    expect(first.pageTitle).not.toBe("");
  });

  it("an object name ranks the object section first", async () => {
    const [first] = await search("Channel Object");
    expect(first).toBeDefined();
    const byName = await search("Message");
    expect(byName.some((h) => h.matchedOn === "object")).toBe(true);
  });

  it("an enum key finds the enum section", async () => {
    const hits = await search("ANNOUNCEMENT_THREAD");
    expect(hits[0].matchedOn).toBe("enum");
    expect(hits.some((h) => h.matchedOn === "enum" && h.sectionId === "resources/channel#channel-object")).toBe(true);
  });

  it("an enum key written with a footnote marker in the docs still matches", async () => {
    const [first] = await search("administrator");
    expect(first).toMatchObject({ matchedOn: "enum", sectionId: "topics/permissions" });
  });

  it("a field name hit has matchedOn field", async () => {
    const hits = await search("rate_limit_per_user");
    expect(hits.some((h) => h.matchedOn === "field")).toBe(true);
  });

  it("plain text search returns text hits", async () => {
    const hits = await search("how to create a slash command");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.matchedOn === "text")).toBe(true);
  });
});

describe("shape", () => {
  it("respects limit", async () => {
    expect(await search("channel", 3)).toHaveLength(3);
    expect((await search("channel", 1)).length).toBe(1);
  });

  it("clamps limit to 20", async () => {
    expect((await search("channel message guild", 500)).length).toBeLessThanOrEqual(20);
  });

  it("dedupes by section base id and never returns a part suffix", async () => {
    const hits = await search("channel", 20);
    const ids = hits.map((h) => h.sectionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => !id.includes("~"))).toBe(true);
  });

  it("a hit inside a split section returns the base id", async () => {
    const parts = (
      await env.DB.prepare("SELECT s.id AS id, s.base_id AS base_id, f.body AS body FROM sections s JOIN sections_fts f ON f.snapshot_id = s.snapshot_id AND f.section_id = s.id WHERE s.snapshot_id = ?1 AND s.part >= 2 LIMIT 40")
        .bind(sid)
        .all<{ id: string; base_id: string; body: string }>()
    ).results;
    expect(parts.length).toBeGreaterThan(0);
    // find a word that occurs in exactly one FTS row, and that row is a later part of a split section
    for (const part of parts) {
      for (const w of new Set(part.body.match(/[A-Za-z_]{6,}/g) ?? [])) {
        const rows = (await env.DB.prepare("SELECT section_id FROM sections_fts WHERE snapshot_id = ?1 AND sections_fts MATCH ?2").bind(sid, `"${w}"`).all<{ section_id: string }>()).results;
        if (rows.length !== 1) continue;
        const hits = await search(w);
        expect(hits[0].sectionId).toBe(part.base_id);
        expect(hits[0].sectionId).not.toContain("~");
        return;
      }
    }
    expect.unreachable("no word unique to a later part of a split section");
  });

  it("area filter applies to every tier", async () => {
    for (const q of ["channel", "Get Channel", "rate_limit_per_user", "GUILD_MEMBERS"]) {
      const hits = await search(q, 8, "resources");
      expect(hits.every((h) => h.sectionId.startsWith("resources/")), q).toBe(true);
    }
    const events = await search("GUILD_MEMBERS", 8, "events");
    expect(events.every((h) => h.sectionId.startsWith("events/"))).toBe(true);
    expect(await search("channel", 8, "no-such-area")).toEqual([]);
  });

  it("is scoped to the snapshot id", async () => {
    expect(await searchDocs(env.DB, sid + 1000, { query: "channel", limit: 8 })).toEqual([]);
  });
});

describe("hostile input", () => {
  it.each([
    '"', "*", "NEAR(", "a OR", "()", "-", "x:y", "😀", "'; DROP TABLE sections; --",
    "", "   ", "!!!", "a AND b NOT c", "title:channel", "{channel.id}", "\u0000", "\\", "heading_path:\"x\" OR body:*",
  ])("input %j does not throw", async (q) => {
    await expect(search(q)).resolves.toBeInstanceOf(Array);
  });

  it("empty and tokenless queries return no hits", async () => {
    expect(await search("")).toEqual([]);
    expect(await search("***")).toEqual([]);
    expect(await search("😀")).toEqual([]);
  });

  it("very long input does not throw", async () => {
    await expect(search("channel ".repeat(1000))).resolves.toBeInstanceOf(Array);
    await expect(search("a".repeat(5000))).resolves.toBeInstanceOf(Array);
    await expect(search("/" + "x/".repeat(2000))).resolves.toBeInstanceOf(Array);
  });

  it("the sections table survives an injection attempt", async () => {
    await search("'; DROP TABLE sections; --");
    const c = (await env.DB.prepare("SELECT count(*) c FROM sections").first()) as { c: number };
    expect(c.c).toBeGreaterThan(100);
  });
});
