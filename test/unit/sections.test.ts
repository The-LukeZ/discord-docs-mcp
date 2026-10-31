import { describe, expect, it } from "vitest";
import { cleanMdx } from "../../src/parse/mdx";
import { slugify } from "../../src/parse/anchors";
import { splitSections } from "../../src/parse/sections";

const tree = (s: string) => cleanMdx(s, { pagePath: "p", snippets: new Map() }).tree;
const page = { path: "p", title: "T" };
const opts = { splitChars: 6000 };

describe("splitSections", () => {
  it("one section per H2/H3 with H4-H6 kept inside", async () => {
    const s = await splitSections(tree("# T\n\nintro\n\n## A\n\na\n\n###### A Structure\n\n|x|\n|-|\n|1|\n\n### B\n\nb"), page, { splitChars: 6000 });
    expect(s.map((x) => [x.heading, x.level])).toEqual([["T", 1], ["A", 2], ["B", 3]]);
    expect(s[1].markdown).toContain("A Structure");
    expect(s[2].headingPath).toEqual(["T", "A", "B"]);
    expect(s[1].subAnchors).toEqual(["a-structure"]);
    expect(s.map((x) => x.ord)).toEqual([0, 1, 2]);
    expect(s[0].anchor).toBe("");
    expect(s[0].id).toBe("p");
    expect(s[1].id).toBe("p#a");
    expect(s[1].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("uses ManualAnchor id over the slug", async () => {
    const s = await splitSections(tree('<ManualAnchor id="custom-id" />\n## Some Heading\n\nx'), page, opts);
    expect(s.at(-1)!.anchor).toBe("custom-id");
  });
  it("splits long sections at H6 boundaries and repeats the heading", async () => {
    const body = Array.from({ length: 4 }, (_, i) => `###### Part ${i}\n\n${"word ".repeat(500)}`).join("\n\n");
    const s = (await splitSections(tree(`## Big\n\n${body}`), page, { splitChars: 6000 })).filter((x) => x.baseId === "p#big");
    expect(s.length).toBeGreaterThan(1);
    expect(s.every((x) => x.markdown.startsWith("## Big"))).toBe(true);
    expect(s.map((x) => x.id)).toEqual(["p#big", "p#big~2", ...s.slice(2).map((_, i) => `p#big~${i + 3}`)]);
  });
  it("splits a single oversized block at blank lines", async () => {
    const code = "```\n" + Array.from({ length: 10 }, () => "x".repeat(1000)).join("\n\n") + "\n```";
    const s = await splitSections(tree(`## Big\n\n${code}`), page, { splitChars: 3000 });
    expect(s.filter((x) => x.baseId === "p#big").length).toBeGreaterThan(1);
  });
  it("collects sub anchors: manual and slug", async () => {
    const s = await splitSections(tree('## A\n\n<ManualAnchor id="m1" />\n\n#### Sub One\n\nx\n\n<ManualAnchor id="stray" />\n\ntext'), page, opts);
    expect(s[1].subAnchors).toEqual(["m1", "stray"]);
  });
  it("<a id> alias adds an anchor without replacing the heading slug", async () => {
    const s = await splitSections(tree('x\n\n<a id="old-name"/>\n## New Name\n\ny'), page, opts);
    expect(s.map((x) => x.anchor)).toEqual(["", "new-name"]);
    expect(s[1].subAnchors).toEqual(["old-name"]);
    expect(s[0].subAnchors).not.toContain("old-name");
  });
  it("dedupes repeated slugs per page across levels", async () => {
    const s = await splitSections(tree("## Dup\n\n#### Dup\n\n## Dup"), page, opts);
    expect(s.map((x) => x.anchor)).toEqual(["", "dup", "dup-2"]);
    expect(s[1].subAnchors).toEqual(["dup-1"]);
  });
  it("slugify", () => {
    expect(slugify("Create Guild Sound!")).toBe("create-guild-sound");
    expect(slugify("New BYPASS_SLOWMODE Permission & Split")).toBe("new-bypassslowmode-permission-split");
    expect(slugify("Bulk-Add Target Users")).toBe("bulk-add-target-users");
  });
});
