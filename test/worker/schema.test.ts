import { env } from "cloudflare:workers";
import { it, expect } from "vitest";

it("applies schema with FTS5 and a seeded refresh_state row", async () => {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all();
  const names = tables.results.map((r: any) => r.name);
  for (const t of ["snapshots","refresh_state","file_contents","snapshot_files","pages","sections","sections_fts","endpoints","objects","fields","enums","enum_keys","redirects","changelog_entries","runs","change_records"])
    expect(names).toContain(t);
  const st = await env.DB.prepare("SELECT * FROM refresh_state").first();
  expect(st).toMatchObject({ id: 1, current_snapshot: null });
});
