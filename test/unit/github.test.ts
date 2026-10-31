import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubSource } from "../../src/refresh/github";

const TOKEN = "github_pat_SECRET123";
const SHA = "0123456789abcdef0123456789abcdef01234567";

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string | undefined;
}
let calls: Call[] = [];
let respond: (url: string) => Response;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), redirect: init?.redirect });
    return respond(url);
  });
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Run `fn`, expect it to reject, and return the error message. */
async function failure(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).message;
    expect(msg).not.toContain(TOKEN);
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(String((e as Error).stack ?? "")).not.toContain(TOKEN);
    return msg;
  }
  throw new Error("expected a rejection");
}

describe("createGitHubSource", () => {
  it("resolves the head of main with auth, user agent and API accept header", async () => {
    respond = () => json({ sha: SHA });
    expect(await createGitHubSource(TOKEN).headSha()).toBe(SHA);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/discord/discord-api-docs/commits/main");
    expect(calls[0].headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "discord-docs-mcp",
      accept: "application/vnd.github+json",
    });
    expect(calls[0].redirect).toBe("manual");
  });

  it("returns only blobs of the recursive tree", async () => {
    respond = () =>
      json({
        sha: SHA,
        truncated: false,
        tree: [
          { path: "developers", type: "tree", sha: "a".repeat(40) },
          { path: "developers/intro.mdx", type: "blob", sha: "b".repeat(40) },
        ],
      });
    expect(await createGitHubSource(TOKEN).tree(SHA)).toEqual([{ path: "developers/intro.mdx", sha: "b".repeat(40) }]);
    expect(calls[0].url).toBe(`https://api.github.com/repos/discord/discord-api-docs/git/trees/${SHA}?recursive=1`);
  });

  it("throws on a truncated tree", async () => {
    respond = () => json({ sha: SHA, truncated: true, tree: [] });
    expect(await failure(() => createGitHubSource(TOKEN).tree(SHA))).toMatch(/truncated/);
  });

  it("downloads raw files pinned to the commit sha", async () => {
    respond = () => new Response("# Hello");
    expect(await createGitHubSource(TOKEN).raw(SHA, "developers/discord-social-sdk/getting-started/using-c++.mdx")).toBe("# Hello");
    expect(calls[0].url).toBe(`https://raw.githubusercontent.com/discord/discord-api-docs/${SHA}/developers/discord-social-sdk/getting-started/using-c%2B%2B.mdx`);
    expect(calls[0].headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, "user-agent": "discord-docs-mcp" });
  });

  it("errors carry status and path only, never the token", async () => {
    respond = () => new Response(`bad credentials ${TOKEN}`, { status: 401 });
    const gh = createGitHubSource(TOKEN);
    expect(await failure(() => gh.raw(SHA, "developers/intro.mdx"))).toBe("github raw 401 developers/intro.mdx");
    expect(await failure(() => gh.headSha())).toBe("github api 401 commits/main");
    expect(await failure(() => gh.tree(SHA))).toBe(`github api 401 git/trees/${SHA}`);
  });

  it("network errors do not leak request details", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError(`fetch failed: Authorization: Bearer ${TOKEN}`);
    });
    expect(await failure(() => createGitHubSource(TOKEN).raw(SHA, "docs.json"))).toBe("github raw request failed docs.json");
  });

  it("rejects malformed shas and responses", async () => {
    respond = () => json({ sha: "../../evil" });
    const gh = createGitHubSource(TOKEN);
    expect(await failure(() => gh.headSha())).toBe("github api unexpected response commits/main");
    expect(await failure(() => gh.tree("main"))).toMatch(/invalid sha/);
    expect(await failure(() => gh.raw("main", "docs.json"))).toMatch(/invalid sha/);
    expect(calls).toHaveLength(1);
  });

  it("follows redirects only within the GitHub hosts and never sends the token elsewhere", async () => {
    respond = (url) =>
      url.startsWith("https://raw.githubusercontent.com/discord/discord-api-docs/")
        ? new Response(null, { status: 302, headers: { location: "https://raw.githubusercontent.com/moved/file.mdx" } })
        : new Response("moved content");
    expect(await createGitHubSource(TOKEN).raw(SHA, "docs.json")).toBe("moved content");
    expect(calls.map((c) => c.url)).toEqual([
      `https://raw.githubusercontent.com/discord/discord-api-docs/${SHA}/docs.json`,
      "https://raw.githubusercontent.com/moved/file.mdx",
    ]);

    calls = [];
    respond = () => new Response(null, { status: 301, headers: { location: "https://evil.example/steal" } });
    expect(await failure(() => createGitHubSource(TOKEN).raw(SHA, "docs.json"))).toBe("github raw redirect to a disallowed location docs.json");
    respond = () => new Response(null, { status: 301, headers: { location: "http://raw.githubusercontent.com/x" } });
    expect(await failure(() => createGitHubSource(TOKEN).raw(SHA, "docs.json"))).toBe("github raw redirect to a disallowed location docs.json");
    expect(calls.every((c) => c.url.startsWith("https://raw.githubusercontent.com/"))).toBe(true);
  });
});
