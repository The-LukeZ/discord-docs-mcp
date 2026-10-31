import { describe, expect, it } from "vitest";
import { pagePathFromRepoPath, pageUrl, parseNavigation } from "../../src/parse/navigation";
import { loadCorpus } from "./corpus";

const { files } = loadCorpus();
const nav = parseNavigation(files["docs.json"]);

describe("navigation", () => {
  it("maps every navigation page to a breadcrumb of group labels", () => {
    expect(nav.breadcrumbs.get("resources/channel")?.length).toBeGreaterThan(0);
    for (const [, crumbs] of nav.breadcrumbs) expect(crumbs.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
  });
  it("reads redirects", () => {
    expect(nav.redirects.length).toBeGreaterThan(0);
    expect(nav.redirects[0]).toEqual({ source: expect.any(String), destination: expect.any(String) });
  });
  it("builds public URLs", () => {
    expect(pagePathFromRepoPath("developers/resources/channel.mdx")).toBe("resources/channel");
    expect(pageUrl("resources/channel", "channel-object")).toBe("https://docs.discord.com/developers/resources/channel#channel-object");
  });
});
