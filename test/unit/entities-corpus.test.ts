import { describe, expect, it } from "vitest";
import { cleanMdx } from "../../src/parse/mdx";
import { extractEntities, type ExtractedEntities } from "../../src/parse/entities";
import { sectionUnits, splitSections } from "../../src/parse/sections";
import { loadCorpus } from "./corpus";

describe("entities over the corpus", () => {
  it("covers every route, every X Object with an X Structure, and the key enums", { timeout: 120_000 }, async () => {
    const { files } = loadCorpus();
    const snippets = new Map(Object.entries(files).filter(([k]) => k.startsWith("snippets/")));
    const all: ExtractedEntities = { endpoints: [], objects: [], enums: [], problems: [] };
    const perPage: Array<[string, number]> = [];
    let routes = 0;
    const missing: string[] = [];
    for (const [file, src] of Object.entries(files)) {
      if (!file.startsWith("developers/") || !file.endsWith(".mdx")) continue;
      const pagePath = file.replace(/^developers\//, "").replace(/\.mdx$/, "");
      // change-log.mdx mentions 6 routes inline in prose (cross-references to endpoints documented elsewhere);
      // they are not endpoint definitions and would only duplicate real endpoints, so they are not counted.
      const n = file === "developers/change-log.mdx" ? 0 : (src.match(/<Route/g) ?? []).length;
      routes += n;
      const { tree, frontmatter } = cleanMdx(src, { pagePath, snippets });
      const sections = await splitSections(tree, { path: pagePath, title: frontmatter.title ?? pagePath }, { splitChars: 6000 });
      const r = extractEntities(sectionUnits(tree), sections);
      if (r.endpoints.length !== n) perPage.push([`${pagePath}: expected ${n}, got ${r.endpoints.length}`, n]);
      for (const k of ["endpoints", "objects", "enums", "problems"] as const) (all[k] as unknown[]).push(...r[k]);
      const names = new Set(r.objects.map((o) => o.name));
      for (const u of sectionUnits(tree)) {
        const m = u.heading && u.level === 3 ? /^(.+) Object$/.exec(headingText(u.heading)) : null;
        if (m && u.body.some((b) => b.type === "heading" && headingText(b) === `${m[1]} Structure`) && !names.has(m[1])) missing.push(`${pagePath}: ${m[1]}`);
      }
    }
    if (perPage.length) console.log(perPage.map((p) => p[0]).join("\n"));
    expect(all.endpoints.length).toBe(routes);
    expect(missing).toEqual([]);
    expect(all.problems).toEqual([]);
    expect(all.objects.every((o) => o.fields.length >= 1)).toBe(true);
    const channel = all.objects.find((o) => o.name === "Channel");
    expect(channel?.fields.map((f) => f.name)).toContain("rate_limit_per_user");
    expect(all.enums.find((e) => e.name === "Channel Types")?.rows.some((r) => r[0] === "GUILD_TEXT")).toBe(true);
    expect(all.enums.some((e) => e.name.endsWith("Permission Flags") && e.rows.some((r) => r.some((c) => c.includes("ADMINISTRATOR"))))).toBe(true);
  });
});

function headingText(n: any): string {
  const walk = (x: any): string => (typeof x.value === "string" ? x.value : (x.children ?? []).map(walk).join(""));
  return walk(n);
}
