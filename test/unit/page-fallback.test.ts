import { describe, expect, it, vi } from "vitest";
import { parseNavigation } from "../../src/parse/navigation";
import { parsePage } from "../../src/parse/page";
import { loadCorpus } from "./corpus";

// Separate file so the mocks cannot leak into page.test.ts (vitest isolates modules per test file).
vi.mock("../../src/parse/entities", () => ({
  extractEntities: () => {
    throw new Error("boom entities\n    at stack line");
  },
}));
vi.mock("../../src/parse/changelog", () => ({
  extractChangelog: () => {
    throw new Error("boom changelog\n    at stack line");
  },
}));

const { files } = loadCorpus();
const snippets = new Map(Object.entries(files).filter(([k]) => k.startsWith("snippets/")));
const ctx = { snippets, nav: parseNavigation(files["docs.json"]), splitChars: 6000 };

describe("parsePage fallbacks (forced failures)", () => {
  it("keeps sections and records a one-line problem when entity extraction throws", { timeout: 60_000 }, async () => {
    const p = await parsePage({ path: "developers/resources/channel.mdx", content: files["developers/resources/channel.mdx"] }, ctx);
    expect(p.sections.length).toBeGreaterThan(1);
    expect([p.endpoints, p.objects, p.enums]).toEqual([[], [], []]);
    expect(p.problems).toContain("entity extraction failed (resources/channel): boom entities");
    expect(p.problems.every((x) => !x.includes("\n") && !x.includes("at stack"))).toBe(true);
  });

  it("keeps sections and records a one-line problem when the changelog extractor throws", { timeout: 60_000 }, async () => {
    const p = await parsePage({ path: "developers/change-log.mdx", content: files["developers/change-log.mdx"] }, ctx);
    expect(p.sections.length).toBeGreaterThan(10);
    expect(p.changelog).toEqual([]);
    expect(p.problems).toContain("changelog parsing failed (change-log): boom changelog");
    expect(p.problems).toContain("entity extraction failed (change-log): boom entities");
    expect(p.problems.every((x) => !x.includes("\n"))).toBe(true);
  });
});
