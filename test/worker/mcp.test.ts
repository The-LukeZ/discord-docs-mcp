import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readConfig } from "../../src/config";
import { createApp } from "../../src/http/app";
import { guard } from "../../src/mcp/server";
import { recentChangesTool } from "../../src/mcp/tools";
import { indexCorpus } from "./corpus-index";
import { callTool, callToolRaw, initialize, listTools, type McpToolResult } from "./mcp-client";

beforeAll(async () => {
  await indexCorpus(env.DB);
}, 120_000);
afterEach(() => vi.restoreAllMocks());

const GENERIC = "Internal error. Please try again later.";
let n = 0;
/** A name no other test has used, so limiter counters and cache keys never interfere. */
const uniq = (p: string) => `${p}-${Date.now()}-${n++}`;
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

/** Collect parsed `tool` log lines. */
function toolLogs() {
  const lines: Array<Record<string, any>> = [];
  vi.spyOn(console, "log").mockImplementation((l) => {
    try {
      const o = JSON.parse(String(l));
      if (o.event === "tool") lines.push(o);
    } catch {
      // not a JSON log line
    }
  });
  return lines;
}

describe("protocol", () => {
  it("lists six tools without auth", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_section", "lookup_endpoint", "lookup_enum", "lookup_object", "recent_changes", "search_docs"]);
  });

  it("marks every tool read-only and describes when to use it", async () => {
    for (const t of await listTools()) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect((t.description ?? "").length).toBeGreaterThan(40);
    }
  });

  it("input schemas match the spec", async () => {
    const by = Object.fromEntries((await listTools()).map((t) => [t.name, t]));
    const search = by.search_docs.inputSchema.properties;
    expect(by.search_docs.inputSchema.required).toEqual(["query"]);
    expect(search.limit).toMatchObject({ minimum: 1, maximum: 20 });
    expect(search.area.type).toBe("string");
    expect(Object.keys(by.get_section.inputSchema.properties).sort()).toEqual(["cursor", "section_id", "url"]);
    expect(by.get_section.inputSchema.required ?? []).toEqual([]);
    expect(by.get_section.description).toMatch(/cursor/i);
    expect(by.get_section.description).toMatch(/same section_id or url/i);
    const recent = by.recent_changes.inputSchema.properties;
    expect(recent.source.enum).toEqual(["changelog", "docs", "both"]);
    expect(recent.limit).toMatchObject({ minimum: 1, maximum: 100 });
    expect(by.recent_changes.inputSchema.required ?? []).toEqual([]);
    expect(by.lookup_endpoint.inputSchema.required).toEqual(["query"]);
    expect(by.lookup_object.inputSchema.required).toEqual(["name"]);
    expect(by.lookup_enum.inputSchema.required).toEqual(["name"]);
  });

  it("server instructions carry the attribution", async () => {
    const { body } = await initialize();
    expect(body.result.instructions).toContain("Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.");
  });

  it("search_docs over the protocol", async () => {
    const r = await callTool("search_docs", { query: "Create Message" });
    expect(r.isError ?? false).toBe(false);
    expect(r.content[0].text).toContain("https://docs.discord.com/developers/");
  });

  it("recent_changes works over the protocol with no arguments", async () => {
    const r = await callTool("recent_changes", {});
    expect(r.isError ?? false).toBe(false);
  });

  it("recent_changes tolerates a missing input object", async () => {
    const r = await recentChangesTool(env.DB, readConfig(env), undefined as any);
    expect(r.isError).toBe(false);
  });
});

describe("routes", () => {
  it("GET / redirects to the repository", async () => {
    const r = await SELF.fetch("https://x/", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://github.com/The-LukeZ/discord-docs-mcp");
  });

  it("unknown routes stay 404", async () => {
    expect((await SELF.fetch("https://x/nope")).status).toBe(404);
  });
});

describe("cache", () => {
  it("second identical call is served from cache", async () => {
    const logs = toolLogs();
    const args = { query: `Get Channel cache ${uniq("c")}` };
    await callTool("search_docs", args);
    await callTool("search_docs", args);
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.cached)).toEqual([false, true]);
    expect(logs[0]).toMatchObject({ tool: "search_docs", args, isError: false });
    expect(typeof logs[0].ms).toBe("number");
  });

  it("key order of arguments does not matter", async () => {
    const logs = toolLogs();
    const q = `Create Message order ${uniq("o")}`;
    await callTool("search_docs", { query: q, limit: 3 });
    await callTool("search_docs", { limit: 3, query: q });
    expect(logs.map((l) => l.cached)).toEqual([false, true]);
  });

  it("new snapshot invalidates cache", async () => {
    const logs = toolLogs();
    const args = { name: "Channel" };
    await callTool("lookup_object", args);
    await callTool("lookup_object", args);
    const row = await env.DB.prepare(
      "SELECT s.id AS id, s.commit_sha AS sha FROM refresh_state rs JOIN snapshots s ON s.id = rs.current_snapshot WHERE rs.id = 1",
    ).first<{ id: number; sha: string }>();
    await env.DB.prepare("UPDATE snapshots SET commit_sha = ?1 WHERE id = ?2").bind("f".repeat(40), row!.id).run();
    try {
      await callTool("lookup_object", args);
    } finally {
      await env.DB.prepare("UPDATE snapshots SET commit_sha = ?1 WHERE id = ?2").bind(row!.sha, row!.id).run();
    }
    expect(logs.map((l) => l.cached)).toEqual([false, true, false]);
  });

  it("error results are not cached", async () => {
    const logs = toolLogs();
    const args = { name: `Nonexistent ${uniq("e")}` };
    const a = await callTool("lookup_object", args);
    const b = await callTool("lookup_object", args);
    expect(a.isError).toBe(true);
    expect(b.isError).toBe(true);
    expect(logs.map((l) => [l.cached, l.isError])).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it("a cache failure does not fail the call", async () => {
    vi.spyOn(caches.default, "match").mockRejectedValue(new Error("cache down"));
    vi.spyOn(caches.default, "put").mockRejectedValue(new Error("cache down"));
    const r = await callTool("search_docs", { query: `Get Channel nocache ${uniq("n")}` });
    expect(r.isError ?? false).toBe(false);
    expect(r.content[0].text).toContain("indexed_commit");
  });
});

describe("guard", () => {
  it("returns a generic error when a tool throws, and logs the class only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    const r = await guard(
      env,
      "forced",
      { query: "x" },
      async () => {
        throw new RangeError("db exploded at /srv/secret.ts:12");
      },
      uniq("g"),
    );
    expect(r).toEqual({ text: GENERIC, isError: true });
    const joined = lines.join("\n");
    expect(joined).toContain('"event":"tool_error"');
    expect(joined).toContain('"tool":"forced"');
    expect(joined).not.toMatch(/exploded|secret\.ts/);
  });

  it("returns the generic error over the protocol when a tool throws", async () => {
    // A database whose queries throw makes a real tool throw.
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1 secret failure");
        },
      },
    } as unknown as Env;
    const app = createApp({ limiterName: uniq("boom") });
    const fetcher = async (req: Request) => app.request(req, undefined, broken, ctx);
    const { body } = await callToolRaw("search_docs", { query: "x" }, {}, fetcher);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(GENERIC);
    expect(JSON.stringify(body)).not.toContain("secret failure");
  });

  it("fails closed when the limiter throws: the tool never runs", async () => {
    let ran = false;
    const broken = {
      ...env,
      LIMITER: {
        jurisdiction: () => ({
          getByName: () => ({
            consume: async () => {
              throw new Error("limiter down");
            },
          }),
        }),
      },
    } as unknown as Env;
    const r = await guard(broken, "t", {}, async () => {
      ran = true;
      return { text: "x", isError: false };
    });
    expect(r).toEqual({ text: GENERIC, isError: true });
    expect(ran).toBe(false);
  });

  it("cap trip returns a tool error, not an HTTP error", async () => {
    const capped = { ...env, CAP_PER_MINUTE: "2" } as unknown as Env;
    const app = createApp({ limiterName: uniq("cap") });
    const fetcher = async (req: Request) => app.request(req, undefined, capped, ctx);
    // Only tools/call reaches the limiter (initialize does not).
    const first = await callTool("search_docs", { query: "Create Message" }, {}, fetcher);
    const second = await callTool("search_docs", { query: "Create Message" }, {}, fetcher); // cached, still counts
    expect(first.isError ?? false).toBe(false);
    expect(second.isError ?? false).toBe(false);
    const third = await callToolRaw("search_docs", { query: "Create Message" }, {}, fetcher);
    expect(third.res.status).toBe(200);
    const result = third.body.result as McpToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Usage cap reached \(2 calls per minute\)\. Retry in \d+ seconds\.$/);
  });

  it("day cap trip names the day window and its cap", async () => {
    const capped = { ...env, CAP_PER_DAY: "1" } as unknown as Env;
    const name = uniq("day");
    const ok = async () => ({ text: "ok", isError: false });
    expect((await guard(capped, "t", {}, ok, name)).isError).toBe(false);
    const r = await guard(capped, "t", {}, ok, name);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Usage cap reached \(1 calls per day\)\. Retry in \d+ seconds\.$/);
  });
});
