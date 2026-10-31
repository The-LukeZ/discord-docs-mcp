import { describe, expect, it } from "vitest";
import { parseNavigation } from "../../src/parse/navigation";
import { parsePage } from "../../src/parse/page";
import { loadCorpus } from "./corpus";

const { files } = loadCorpus();
const snippets = new Map(Object.entries(files).filter(([k]) => k.startsWith("snippets/")));
const nav = parseNavigation(files["docs.json"]);
const ctx = { snippets, nav, splitChars: 6000 };
const file = (path: string) => ({ path, content: files[path] });

describe("parsePage", () => {
  it("parses change-log.mdx newest first", { timeout: 60_000 }, async () => {
    const p = await parsePage(file("developers/change-log.mdx"), ctx);
    expect(p.changelog.length).toBeGreaterThan(10);
    expect(p.changelog[0].date >= p.changelog[1].date).toBe(true);
    expect(p.changelog[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.changelog[0].url).toMatch(/^https:\/\/docs\.discord\.com\/developers\/change-log#/);
    expect(p.endpoints).toEqual([]);
    expect(p.problems).toEqual([]);
    expect(p.changelog.length).toBe(246);
    for (let i = 1; i < p.changelog.length; i++) expect(p.changelog[i - 1].date >= p.changelog[i].date).toBe(true);
    const e = p.changelog[0];
    expect(e.id).not.toBe("");
    expect(e.url.endsWith("#" + e.id)).toBe(true);
    expect(e.title).not.toBe("");
    expect(e.markdown).not.toBe("");
    expect(e.tags.length).toBeGreaterThan(0);
    expect(p.changelog.every((x) => x.links.every((l) => /^https?:\/\//.test(l)))).toBe(true);
    expect(p.changelog.every((x) => new Set(x.links).size === x.links.length)).toBe(true);
    expect(new Set(p.changelog.map((x) => x.id)).size).toBe(p.changelog.length);
    // ids must be real section anchors
    const anchors = new Set(p.sections.map((s) => s.anchor));
    expect(p.changelog.every((x) => anchors.has(x.id))).toBe(true);
  });

  it("parses resources/channel with entities and breadcrumb", { timeout: 60_000 }, async () => {
    const p = await parsePage(file("developers/resources/channel.mdx"), ctx);
    expect(p.meta.path).toBe("resources/channel");
    expect(p.meta.url).toBe("https://docs.discord.com/developers/resources/channel");
    expect(p.meta.breadcrumb.length).toBeGreaterThan(0);
    expect(p.endpoints.some((e) => e.name === "Get Channel")).toBe(true);
    expect(p.objects.some((o) => o.name === "Channel")).toBe(true);
    expect(p.sections.every((s) => s.subAnchors !== undefined)).toBe(true);
    expect(p.changelog).toEqual([]);
  });

  it("records snippet deps for a Social SDK page", { timeout: 60_000 }, async () => {
    const path = Object.keys(files).find((k) => k.startsWith("developers/discord-social-sdk/") && /from ["']\/?snippets\/[^"']*\.mdx["']/.test(files[k]))!;
    const p = await parsePage(file(path), ctx);
    expect(p.snippetDeps.length).toBeGreaterThan(0);
    expect(p.snippetDeps).toEqual([...new Set(p.snippetDeps)].sort());
  });

  it("falls back to plain sections when entity extraction throws", async () => {
    const p = await parsePage({ path: "developers/x.mdx", content: "## A\n\n| a |\n|-|-|-|\n| b" }, ctx);
    expect(p.sections.length).toBeGreaterThan(0);
    expect(p.meta.title).toBe("x");
    expect(p.meta.breadcrumb).toEqual([]);
  });

  it("title: frontmatter, else first H1, else path", async () => {
    const t = async (content: string) => (await parsePage({ path: "developers/a/b.mdx", content }, ctx)).meta.title;
    expect(await t('---\ntitle: "FM"\n---\n\n# H\n\nx')).toBe("FM");
    expect(await t("# Heading One\n\nx")).toBe("Heading One");
    expect(await t("just text")).toBe("a/b");
  });

  it("skips changelog entries with an unparseable date and records a problem", async () => {
    const content = [
      "# Change Log",
      '<Update label="not a date" tags={["X"]}>\n\n    body one\n</Update>',
      '<Update label="January 2, 2026" tags={["HTTP API"]} rss={{ title: "T", description: "D" }}>\n\n    See [a](https://example.com/a) and https://example.com/a and [b](https://example.com/b).\n</Update>',
      '<Update label="March 3, 2026" tags={[]}>\n\n    ## Heading line\n\n    text\n</Update>',
    ].join("\n\n");
    const p = await parsePage({ path: "developers/change-log.mdx", content }, ctx);
    expect(p.changelog.map((e) => e.date)).toEqual(["2026-03-03", "2026-01-02"]);
    expect(p.problems.some((x) => x.includes("not a date"))).toBe(true);
    expect(p.changelog[1]).toMatchObject({ title: "T", description: "D", tags: ["HTTP API"], links: ["https://example.com/a", "https://example.com/b"] });
    expect(p.changelog[0].title).toBe("Heading line");
  });
});

describe("empty titles fall back", () => {
  it("empty frontmatter title and empty rss title are ignored", async () => {
    const content = ['---\ntitle: ""\n---', "# Real Title", '<Update label="January 2, 2026" tags={[]} rss={{ title: "  ", description: "D" }}>\n\n    first line here\n</Update>'].join("\n\n");
    const p = await parsePage({ path: "developers/change-log.mdx", content }, ctx);
    expect(p.meta.title).toBe("Real Title");
    expect(p.changelog[0].title).toBe("first line here");
  });
});
