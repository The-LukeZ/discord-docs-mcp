import { describe, expect, it } from "vitest";
import { baseId, cell, decodeCursor, docsUrl, encodeCursor, envelope, mdTable, oneLine, truncate } from "../../src/mcp/format";

const info = { id: 1, commitSha: "abc123", indexedAt: "2026-10-31T10:00:00.000Z", stale: false };

describe("cursor", () => {
  it("round trips", () => {
    const c = { target: "resources/channel#channel-object", offset: 1234 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("is url-safe and whitespace free", () => {
    const s = encodeCursor({ target: "topics/permissions#bitwise-permission-flags~2 ü 😀", offset: 7 });
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(s)).toEqual({ target: "topics/permissions#bitwise-permission-flags~2 ü 😀", offset: 7 });
  });

  it("decodes garbage to null", () => {
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor("x".repeat(5000))).toBeNull();
  });

  it("rejects well-formed base64 with the wrong shape", () => {
    const enc = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeCursor(enc({ target: "a" }))).toBeNull();
    expect(decodeCursor(enc({ target: 5, offset: 1 }))).toBeNull();
    expect(decodeCursor(enc({ target: "a", offset: -1 }))).toBeNull();
    expect(decodeCursor(enc({ target: "a", offset: 1.5 }))).toBeNull();
    expect(decodeCursor(enc({ target: "a", offset: "1" }))).toBeNull();
    expect(decodeCursor(enc(["a", 1]))).toBeNull();
    expect(decodeCursor(enc(null))).toBeNull();
  });
});

describe("truncate", () => {
  it("returns everything when it fits", () => {
    expect(truncate("hello", 0, 100)).toEqual({ slice: "hello", nextOffset: null });
    expect(truncate("hello", 0, 5)).toEqual({ slice: "hello", nextOffset: null });
  });

  it("cuts at the last blank line before the cap", () => {
    const text = "aaaa\n\nbbbb\n\ncccccccc";
    const r = truncate(text, 0, 14);
    expect(r.slice).toBe("aaaa\n\nbbbb");
    expect(r.slice.length).toBeLessThanOrEqual(14);
    expect(text.slice(r.nextOffset!)).toBe("cccccccc");
  });

  it("hard cuts when there is no blank line", () => {
    const r = truncate("x".repeat(100), 0, 30);
    expect(r.slice).toBe("x".repeat(30));
    expect(r.nextOffset).toBe(30);
  });

  it("falls back to the last line break so table rows stay whole", () => {
    const text = "| a | 1 |\n| b | 2 |\n| c | 3 |\n| d | 4 |";
    const r = truncate(text, 0, 25);
    expect(r.slice).toBe("| a | 1 |\n| b | 2 |");
    expect(text.slice(r.nextOffset!)).toBe("| c | 3 |\n| d | 4 |");
  });

  it("does not split a surrogate pair on a hard cut", () => {
    const text = "a" + "😀".repeat(20);
    const r = truncate(text, 0, 4);
    expect(r.slice.length).toBeLessThanOrEqual(4);
    expect(r.slice).not.toMatch(/[\ud800-\udbff]$/);
    expect(r.nextOffset).toBe(r.slice.length);
  });

  it("paging with nextOffset reassembles the text and always makes progress", () => {
    const text = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ${"w".repeat(i % 17)}`).join("\n\n") + "\n\n" + "z".repeat(90);
    let offset = 0;
    let out = "";
    let pages = 0;
    for (;;) {
      const { slice, nextOffset } = truncate(text, offset, 60);
      expect(slice.length).toBeLessThanOrEqual(60);
      out += slice;
      pages++;
      if (nextOffset === null) break;
      expect(nextOffset).toBeGreaterThan(offset);
      out += text.slice(offset + slice.length, nextOffset); // skipped separator
      offset = nextOffset;
      expect(pages).toBeLessThan(200);
    }
    expect(out).toBe(text);
  });

  it("starts from the offset", () => {
    expect(truncate("0123456789", 4, 100)).toEqual({ slice: "456789", nextOffset: null });
  });

  it("an offset at or past the end gives an empty slice", () => {
    expect(truncate("abc", 3, 10)).toEqual({ slice: "", nextOffset: null });
    expect(truncate("abc", 99, 10)).toEqual({ slice: "", nextOffset: null });
  });

  it("a non-positive cap still makes progress", () => {
    const r = truncate("abcdef", 0, 0);
    expect(r.slice.length).toBeGreaterThan(0);
    expect(r.nextOffset).toBeGreaterThan(0);
  });
});

describe("envelope", () => {
  it("carries commit, time and attribution", () => {
    const t = envelope("body", info);
    expect(t.startsWith("body\n\n---\n")).toBe(true);
    expect(t).toContain("indexed_commit: abc123 | indexed_at: 2026-10-31T10:00:00.000Z");
    expect(t).toContain("Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.");
  });

  it("warns only when stale", () => {
    expect(envelope("b", info)).not.toMatch(/stale/i);
    const t = envelope("b", { ...info, stale: true });
    expect(t).toContain("Warning: index is stale (last successful refresh 2026-10-31T10:00:00.000Z).");
  });
});

describe("helpers", () => {
  it("baseId strips a part suffix only", () => {
    expect(baseId("resources/channel#channel-object~4")).toBe("resources/channel#channel-object");
    expect(baseId("resources/channel#channel-object")).toBe("resources/channel#channel-object");
    expect(baseId("resources/channel")).toBe("resources/channel");
  });

  it("docsUrl builds the public url from a section id", () => {
    expect(docsUrl("resources/channel#channel-object~2")).toBe("https://docs.discord.com/developers/resources/channel#channel-object");
    expect(docsUrl("resources/channel")).toBe("https://docs.discord.com/developers/resources/channel");
  });

  it("cell escapes pipes and newlines", () => {
    expect(cell("a | b\nc")).toBe("a \\| b c");
  });

  it("mdTable renders header, separator and rows", () => {
    expect(mdTable(["A", "B"], [["1", "x|y"], ["2"]])).toBe("| A | B |\n| --- | --- |\n| 1 | x\\|y |\n| 2 |  |");
  });

  it("oneLine collapses whitespace and shortens", () => {
    expect(oneLine("a \n\n  b")).toBe("a b");
    expect(oneLine("x".repeat(50), 10)).toBe("xxxxxxxxx…");
  });
});
