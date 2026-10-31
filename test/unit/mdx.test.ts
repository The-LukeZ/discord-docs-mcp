import { describe, expect, it } from "vitest";
import { cleanMdx, toMarkdown } from "../../src/parse/mdx";
import { loadCorpus } from "./corpus";

const ctx = { pagePath: "p", snippets: new Map<string, string>() };

describe("cleanMdx", () => {
  it("turns Route into an endpoint line with unescaped braces and link text", () => {
    const r = cleanMdx('## Get Channel\n\n<Route method="GET">/channels/[\\{channel.id\\}](/developers/resources/channel#channel-object)</Route>\n', ctx);
    expect(toMarkdown(r.tree)).toContain("`GET /channels/{channel.id}`");
  });
  it("drops imports and inlines snippet partials", () => {
    const snippets = new Map([["snippets/x/part.mdx", "Shared **text**."]]);
    const r = cleanMdx('import Part from "/snippets/x/part.mdx";\n\n<Part />\n', { pagePath: "p", snippets });
    expect(toMarkdown(r.tree)).toContain("Shared **text**.");
    expect(toMarkdown(r.tree)).not.toContain("import");
    expect(r.snippetDeps).toEqual(["snippets/x/part.mdx"]);
  });
  it("records nested snippet deps, guards cycles and reports missing snippets", () => {
    const snippets = new Map([
      ["snippets/a.mdx", 'import B from "/snippets/b.mdx";\n\nA <B />'],
      ["snippets/b.mdx", 'import A from "/snippets/a.mdx";\n\nB <A />'],
    ]);
    const r = cleanMdx('import A from "/snippets/a.mdx";\nimport M from "/snippets/missing.mdx";\n\n<A />\n\n<M />\n', { pagePath: "p", snippets });
    expect(r.snippetDeps.sort()).toEqual(["snippets/a.mdx", "snippets/b.mdx"]);
    expect(r.problems.length).toBeGreaterThan(0);
  });
  it("keeps title, sidebarTitle, description only", () => {
    const r = cleanMdx("---\ntitle: T\nsidebarTitle: S\ndescription: D\nmode: wide\n---\nBody", ctx);
    expect(r.frontmatter).toEqual({ title: "T", sidebarTitle: "S", description: "D" });
  });
  it("renders callouts as blockquotes and unwraps unknown JSX keeping text", () => {
    const md = toMarkdown(cleanMdx("<Warning>Careful</Warning>\n\n<Mystery foo=\"1\">Inner text</Mystery>", ctx).tree);
    expect(md).toContain("> **Warning:** Careful");
    expect(md).toContain("Inner text");
    expect(md).not.toContain("Mystery");
  });
  it("rewrites internal links to absolute URLs", () => {
    const md = toMarkdown(cleanMdx("[x](/developers/resources/guild#guild-object) [y](#local)", { pagePath: "resources/channel", snippets: new Map() }).tree);
    expect(md).toContain("https://docs.discord.com/developers/resources/guild#guild-object");
    expect(md).toContain("https://docs.discord.com/developers/resources/channel#local");
  });
  it("renders Update as an H2 with its label", () => {
    expect(toMarkdown(cleanMdx('<Update label="October 30, 2026" tags={["HTTP API"]}>Body</Update>', ctx).tree)).toMatch(/^## October 30, 2026\n\nBody/m);
  });
  it("records a problem instead of throwing on unparseable MDX", () => {
    const r = cleanMdx("<Broken\n\ntext {", ctx);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(toMarkdown(r.tree)).toContain("text");
  });
  it("keeps ManualAnchor markers in the tree but not in markdown", () => {
    const r = cleanMdx('<ManualAnchor id="foo" />\n\n## Heading\n', ctx);
    expect(r.tree.children.some((n) => n.type === "manualAnchor" && n.id === "foo")).toBe(true);
    expect(toMarkdown(r.tree)).not.toContain("foo");
  });
  it("hoists a ManualAnchor inside a heading to a block before it", () => {
    const r = cleanMdx('###### JSON <ManualAnchor id="x-json" />\n\ntext\n', ctx);
    expect(r.tree.children.map((n) => n.type)).toEqual(["manualAnchor", "heading", "paragraph"]);
    expect(toMarkdown(r.tree)).toBe("###### JSON\n\ntext\n");
  });
  it("preserves Update tags and rss on the H2 node", () => {
    const src = '<Update label="October 30, 2026" tags={["HTTP API", "Gateway"]} rss={{\n  title: "T",\n  description: "It\'s D"\n}}>\n\nBody\n\n</Update>';
    const h = cleanMdx(src, ctx).tree.children[0] as any;
    expect(h.type).toBe("heading");
    expect(h.data.update).toEqual({ label: "October 30, 2026", tags: ["HTTP API", "Gateway"], rssTitle: "T", rssDescription: "It's D" });
  });
  it("renders titled components, images and expressions", () => {
    const md = toMarkdown(cleanMdx('<Card title="Hi" href="/x">Body</Card>\n\n<img src="a.png" alt="Logo" />\n\n<img src="b.png" alt="" />\n\n{"literal"} {1 + 1}', ctx).tree);
    expect(md).toContain("**Hi**");
    expect(md).toContain("[image: Logo]");
    expect(md).not.toContain("b.png");
    expect(md).toContain("literal");
    expect(md).not.toContain("1 + 1");
  });
});

describe("corpus smoke", () => {
  it("cleans every page without JSX or imports left", () => {
    const { files } = loadCorpus();
    const snippets = new Map<string, string>();
    for (const [p, s] of Object.entries(files)) if (p.startsWith("snippets/")) snippets.set(p, s);
    let fallbacks = 0;
    const srcAnchors = new Set<string>();
    const outAnchors = new Set<string>();
    let firstUpdate: any;
    for (const [p, src] of Object.entries(files)) {
      if (!p.startsWith("developers/") || !p.endsWith(".mdx")) continue;
      const r = cleanMdx(src, { pagePath: p.replace(/^developers\//, "").replace(/\.mdx$/, ""), snippets });
      if (r.problems.some((x) => x.startsWith("mdx parse failed"))) fallbacks++;
      for (const m of src.matchAll(/<ManualAnchor\s+id="([^"]*)"/g)) srcAnchors.add(m[1]!);
      const walk = (n: any) => {
        if (n.type === "manualAnchor") outAnchors.add(n.id);
        if (n.data?.update && p === "developers/change-log.mdx") firstUpdate ??= n.data.update;
        n.children?.forEach(walk);
      };
      walk(r.tree);
      // no JSX or imports outside code: strip fenced and inline code first
      const bare = toMarkdown(r.tree).replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      expect(bare, p).not.toMatch(/^import .* from /m);
      expect(bare, p).not.toMatch(/<\/?(Route|Update|Card|Note|Info|Warning|Tip|Danger|ManualAnchor|Accordion|Step)\b/);
    }
    expect(fallbacks).toBe(0);
    expect(outAnchors).toEqual(srcAnchors);
    expect(firstUpdate.tags.length).toBeGreaterThan(0);
    expect(firstUpdate.rssTitle).toBeTruthy();
  }, 30_000);
});
