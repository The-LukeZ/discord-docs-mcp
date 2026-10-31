import { writeFileSync } from "node:fs";
import path from "node:path";

const REPO = "discord/discord-api-docs";
const token = process.env.GITHUB_FETCH_TOKEN;
const headers: Record<string, string> = {
  "User-Agent": "discord-docs-mcp-fetch-corpus",
  Accept: "application/vnd.github+json",
};
if (token) headers.Authorization = `Bearer ${token}`;

function selected(path: string): boolean {
  return (
    path === "docs.json" ||
    (path.startsWith("developers/") && path.endsWith(".mdx")) ||
    (path.startsWith("snippets/") && path.endsWith(".mdx"))
  );
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status}`);
  return (await res.json()) as T;
}

const head = await api<{ sha: string }>("commits/main");
const sha = head.sha;
const tree = await api<{ truncated: boolean; tree: Array<{ path: string; type: string }> }>(
  `git/trees/${sha}?recursive=1`,
);
if (tree.truncated) throw new Error("tree truncated");

const paths = tree.tree
  .filter((e) => e.type === "blob" && selected(e.path))
  .map((e) => e.path)
  .sort();

const files: Record<string, string> = {};
const queue = [...paths];
async function worker() {
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${p}`);
    if (!res.ok) throw new Error(`raw ${p}: ${res.status}`);
    files[p] = await res.text();
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
const out = path.join(import.meta.dirname, "..", "test", "fixtures", "corpus.json");
writeFileSync(out, JSON.stringify({ commit: sha, files: sorted }, null, 1) + "\n");
console.log(`commit ${sha}, ${paths.length} files`);
