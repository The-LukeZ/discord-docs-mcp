import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { guard } from "../../src/mcp/server";
import { indexCorpus } from "./corpus-index";
import { callTool } from "./mcp-client";

beforeAll(async () => {
  await indexCorpus(env.DB);
}, 120_000);
afterEach(() => vi.restoreAllMocks());

describe("privacy page", () => {
  it("states the required facts", async () => {
    const res = await SELF.fetch("https://x/privacy");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = (await res.text()).toLowerCase();
    for (const s of ["no accounts", "CC-BY-SA 4.0", "not affiliated with Discord", "IP"]) expect(html).toContain(s.toLowerCase());
  });
});

describe("logs", () => {
  const capture = () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => void lines.push(String(l)));
    return lines;
  };

  it("no log line contains client identifiers", async () => {
    const lines = capture();
    await callTool("search_docs", { query: "Get Channel" }, { "CF-Connecting-IP": "203.0.113.9", "User-Agent": "probe-agent" });
    // Prove the capture sees the tool log line, so the negative assertion below is meaningful.
    expect(lines.some((l) => l.includes('"event":"tool"'))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/203\.0\.113\.9|probe-agent/);
  });

  it("tool error logs carry the class name only, never the message", async () => {
    const lines = capture();
    await guard(env, "boom", { query: "x" }, async () => {
      throw new TypeError("secret detail 203.0.113.9");
    });
    const joined = lines.join("\n");
    expect(joined).toContain('"event":"tool_error"');
    expect(joined).toContain("TypeError");
    expect(joined).not.toMatch(/secret detail|203\.0\.113\.9|stack/);
  });
});
