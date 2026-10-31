import corpus from "../fixtures/corpus.json";
import { parseNavigation } from "../../src/parse/navigation";
import { parsePage } from "../../src/parse/page";
import { createSnapshot, publishSnapshot, writePages, writeRedirects, writeSnapshotFiles } from "../../src/store/write";

const COMMIT = (corpus as { commit: string }).commit;
const files = (corpus as { files: Record<string, string> }).files;

/**
 * Parse the whole pinned fixture corpus and publish it as the live snapshot of an empty database. Returns the
 * snapshot id. Slow (every page is parsed in workerd), so call it once per test file from a `beforeAll` with a
 * generous timeout. The corpus has no real git blob shas; each page gets the stable fake `fixture:<repo path>`.
 */
export async function indexCorpus(db: D1Database): Promise<number> {
  const snippets = new Map(Object.entries(files).filter(([k]) => k.startsWith("snippets/")));
  const nav = parseNavigation(files["docs.json"]);
  const ctx = { snippets, nav, splitChars: 6000 };

  const repoPaths = Object.keys(files).filter((k) => k.startsWith("developers/") && k.endsWith(".mdx")).sort();
  const pages = [];
  for (const path of repoPaths) pages.push(await parsePage({ path, content: files[path] }, ctx));

  const blobs = new Map(repoPaths.map((p) => [p, `fixture:${p}`]));
  const id = await createSnapshot(db, COMMIT);
  await writePages(db, id, pages, blobs);
  await writeSnapshotFiles(db, id, repoPaths.map((p) => ({ path: p, blobSha: blobs.get(p)! })));
  await writeRedirects(db, id, nav.redirects);
  if (!(await publishSnapshot(db, id, null))) throw new Error("indexCorpus needs a database with no live snapshot");
  return id;
}
