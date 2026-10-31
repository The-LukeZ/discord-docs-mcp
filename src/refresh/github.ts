/** Read access to the docs repo, pinned to commit SHAs. The real one talks to GitHub; tests use a fake. */
export interface GitHubSource {
  /** sha of the head commit of `main` */
  headSha(): Promise<string>;
  /** every blob (file) of the commit's recursive tree */
  tree(sha: string): Promise<Array<{ path: string; sha: string }>>;
  /** source text of `path` at commit `sha` */
  raw(sha: string, path: string): Promise<string>;
}

const REPO = "discord/discord-api-docs";
const API = `https://api.github.com/repos/${REPO}/`;
const RAW = `https://raw.githubusercontent.com/${REPO}/`;
/** The only hosts the token is ever sent to (over https). */
const ALLOWED_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);
const MAX_REDIRECTS = 3;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * GitHub access for the refresh. The token is only placed in the Authorization header of requests to the two
 * GitHub hosts; redirects are followed by hand so it never reaches another host. Every error is built from a
 * fixed kind, the status code and the repo path, never from headers, URLs or response bodies, so the token
 * cannot end up in logs, thrown errors or stored run records.
 */
export function createGitHubSource(token: string): GitHubSource {
  async function request(kind: "api" | "raw", url: string, label: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": "discord-docs-mcp" };
    if (kind === "api") headers.Accept = "application/vnd.github+json";
    let target = url;
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetch(target, { headers, redirect: "manual" });
      } catch {
        throw new Error(`github ${kind} request failed ${label}`);
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) {
        if (!res.ok) throw new Error(`github ${kind} ${res.status} ${label}`);
        return res;
      }
      const location = res.headers.get("location");
      let next: URL | null = null;
      try {
        next = location ? new URL(location, target) : null;
      } catch {
        next = null;
      }
      if (!next || next.protocol !== "https:" || !ALLOWED_HOSTS.has(next.hostname) || next.username || next.password || hop >= MAX_REDIRECTS)
        throw new Error(`github ${kind} redirect to a disallowed location ${label}`);
      target = next.href;
    }
  }

  /** GET `path` (also the error label) plus an optional query string, parsed as JSON. */
  async function api<T>(path: string, query = ""): Promise<T> {
    const res = await request("api", API + path + query, path);
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(`github api unexpected response ${path}`);
    }
  }

  const checkSha = (sha: string): void => {
    if (!SHA.test(sha)) throw new Error("github invalid sha");
  };

  return {
    async headSha() {
      const body = await api<{ sha?: unknown }>("commits/main");
      if (typeof body?.sha !== "string" || !SHA.test(body.sha)) throw new Error("github api unexpected response commits/main");
      return body.sha;
    },

    async tree(sha) {
      checkSha(sha);
      const label = `git/trees/${sha}`;
      const body = await api<{ truncated?: boolean; tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }> }>(label, "?recursive=1");
      // A truncated tree would make missing files look removed; refuse it rather than publish a partial index.
      if (body?.truncated) throw new Error(`github api tree truncated ${label}`);
      if (!Array.isArray(body?.tree)) throw new Error(`github api unexpected response ${label}`);
      return body.tree
        .filter((e) => e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string")
        .map((e) => ({ path: e.path as string, sha: e.sha as string }));
    },

    async raw(sha, path) {
      checkSha(sha);
      const url = RAW + sha + "/" + path.split("/").map(encodeURIComponent).join("/");
      return (await request("raw", url, path)).text();
    },
  };
}
