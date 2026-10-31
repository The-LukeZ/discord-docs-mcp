import { createHash } from "node:crypto";
import type { GitHubSource } from "../../src/refresh/github";

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/**
 * In-memory stand-in for the GitHub repo: a linear history of commits over a file map. SHAs are deterministic
 * (sha1 of the content / of the parent plus the change set), so test runs are reproducible. Every call is
 * recorded in `calls` as `head`, `tree:<sha>` or `raw:<sha>:<path>`.
 */
export class FakeGitHub implements GitHubSource {
  readonly calls: string[] = [];
  /** when true, every `raw` call throws (simulates a download that fails after retries) */
  failRaw = false;
  head: string;
  private readonly commits = new Map<string, Map<string, string>>(); // commit sha -> path -> blob sha
  private readonly blobs = new Map<string, string>(); // blob sha -> content

  constructor(files: Record<string, string>) {
    this.head = this.store(new Map(), "root", files);
  }

  /** Apply changes (content, or null to delete a path) as a new head commit; returns its sha. */
  commit(changes: Record<string, string | null>): string {
    this.head = this.store(new Map(this.commits.get(this.head)), this.head, changes);
    return this.head;
  }

  /** Blob sha of a path at the head commit. */
  blobSha(path: string): string | undefined {
    return this.commits.get(this.head)!.get(path);
  }

  private store(tree: Map<string, string>, parent: string, changes: Record<string, string | null>): string {
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        tree.delete(path);
        continue;
      }
      const blob = sha1(`blob\0${content}`);
      this.blobs.set(blob, content);
      tree.set(path, blob);
    }
    const sha = sha1(`commit\0${parent}\0${JSON.stringify(Object.entries(changes))}`);
    this.commits.set(sha, tree);
    return sha;
  }

  async headSha(): Promise<string> {
    this.calls.push("head");
    return this.head;
  }

  async tree(sha: string): Promise<Array<{ path: string; sha: string }>> {
    this.calls.push(`tree:${sha}`);
    const tree = this.commits.get(sha);
    if (!tree) throw new Error(`fake github: unknown commit ${sha}`);
    return [...tree].map(([path, blob]) => ({ path, sha: blob }));
  }

  async raw(sha: string, path: string): Promise<string> {
    this.calls.push(`raw:${sha}:${path}`);
    if (this.failRaw) throw new Error(`github raw 503 ${path}`);
    const blob = this.commits.get(sha)?.get(path);
    if (blob === undefined) throw new Error(`github raw 404 ${path}`);
    return this.blobs.get(blob)!;
  }
}
