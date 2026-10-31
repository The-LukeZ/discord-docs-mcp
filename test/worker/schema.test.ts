import { env } from "cloudflare:workers";
import { it, expect } from "vitest";

it("applies schema with FTS5 and a seeded refresh_state row", async () => {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all();
  const names = tables.results.map((r: any) => r.name);
  for (const t of ["snapshots","refresh_state","file_contents","snapshot_files","section_anchors","pages","sections","sections_fts","endpoints","objects","fields","enums","enum_keys","redirects","changelog_entries","runs","change_records"])
    expect(names).toContain(t);
  const st = await env.DB.prepare("SELECT * FROM refresh_state").first();
  expect(st).toMatchObject({ id: 1, current_snapshot: null });
});

it("indexes sections by snapshot and area, and the area subquery uses it", async () => {
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT id FROM sections WHERE snapshot_id = ?1 AND area = ?2",
  )
    .bind(1, "topics")
    .all<{ detail: string }>();
  expect(plan.results.map((r) => r.detail).join("\n")).toContain("idx_sections_area");
});
