import { describe, expect, it } from "vitest";
import { MAX_QUERY_TOKENS, parseEndpointQuery, toFtsQuery } from "../../src/search/query";

describe("toFtsQuery", () => {
  it("neutralizes FTS syntax", () => {
    expect(toFtsQuery('foo" OR * NEAR(', "and")).toBe('"foo" "OR" "NEAR"');
    expect(toFtsQuery("***", "and")).toBeNull();
  });

  it("joins tokens with OR in or mode", () => {
    expect(toFtsQuery("create message", "or")).toBe('"create" OR "message"');
    expect(toFtsQuery("create message", "and")).toBe('"create" "message"');
  });

  it("returns null for empty, punctuation-only and emoji-only input", () => {
    for (const q of ["", "   ", "()-:", "\"'`", "😀🎉"]) {
      expect(toFtsQuery(q, "and")).toBeNull();
      expect(toFtsQuery(q, "or")).toBeNull();
    }
  });

  it("keeps underscores and unicode letters and digits", () => {
    expect(toFtsQuery("rate_limit_per_user", "and")).toBe('"rate_limit_per_user"');
    expect(toFtsQuery("Überprüfung 日本語 v10", "and")).toBe('"Überprüfung" "日本語" "v10"');
  });

  it("splits identifiers on dots, slashes and braces", () => {
    expect(toFtsQuery("/channels/{channel.id}/messages", "and")).toBe('"channels" "channel" "id" "messages"');
  });

  it("caps the number of tokens", () => {
    const q = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const out = toFtsQuery(q, "and")!;
    expect(out.split(" ")).toHaveLength(MAX_QUERY_TOKENS);
    expect(out.endsWith(`"w${MAX_QUERY_TOKENS - 1}"`)).toBe(true);
  });

  it("handles very long input and long tokens", () => {
    const out = toFtsQuery("a".repeat(5000), "and")!;
    expect(out.length).toBeLessThan(400);
    expect(toFtsQuery("x ".repeat(5000), "or")!.split(" OR ")).toHaveLength(MAX_QUERY_TOKENS);
  });

  it("never emits a quote inside a token", () => {
    const out = toFtsQuery('a"b""c \u0000 d\'e', "or")!;
    expect(out).toBe('"a" OR "b" OR "c" OR "d" OR "e"');
  });
});

describe("parseEndpointQuery", () => {
  it("parses endpoint queries", () => {
    expect(parseEndpointQuery("post /interactions/{interaction.id}/{interaction.token}/callback")).toEqual({
      method: "POST",
      path: "/interactions/{}/{}/callback",
    });
    expect(parseEndpointQuery("Get Channel")).toEqual({ name: "Get Channel" });
  });

  it("accepts a lowercase or mixed-case method", () => {
    expect(parseEndpointQuery("get /channels/{channel.id}")).toEqual({ method: "GET", path: "/channels/{}" });
    expect(parseEndpointQuery("Delete /channels/{channel.id}")).toEqual({ method: "DELETE", path: "/channels/{}" });
  });

  it("accepts a path without a method", () => {
    expect(parseEndpointQuery("/channels/{channel.id}/messages")).toEqual({ path: "/channels/{}/messages" });
    expect(parseEndpointQuery("  /channels/123/messages/  ")).toEqual({ path: "/channels/{}/messages" });
  });

  it("normalizes a full API url to a path", () => {
    expect(parseEndpointQuery("GET https://discord.com/api/v10/channels/123")).toEqual({ method: "GET", path: "/channels/{}" });
  });

  it("accepts a bare method", () => {
    expect(parseEndpointQuery("GET")).toEqual({ method: "GET" });
    expect(parseEndpointQuery("patch")).toEqual({ method: "PATCH" });
  });

  it("treats other text as a name, collapsing whitespace", () => {
    expect(parseEndpointQuery("  Create   Guild  Role ")).toEqual({ name: "Create Guild Role" });
    expect(parseEndpointQuery("get channel")).toEqual({ name: "get channel" });
    expect(parseEndpointQuery("GET channels")).toEqual({ name: "GET channels" });
    expect(parseEndpointQuery("GUILD_MEMBERS")).toEqual({ name: "GUILD_MEMBERS" });
  });

  it("does not read a path with spaces as a path", () => {
    expect(parseEndpointQuery("/channels foo")).toEqual({ name: "/channels foo" });
    expect(parseEndpointQuery("GET /channels foo")).toEqual({ name: "GET /channels foo" });
  });

  it("returns an empty object for empty input", () => {
    expect(parseEndpointQuery("")).toEqual({});
    expect(parseEndpointQuery("   ")).toEqual({});
  });
});
