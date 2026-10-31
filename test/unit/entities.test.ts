import { describe, expect, it } from "vitest";
import { cleanMdx } from "../../src/parse/mdx";
import { extractEntities, normalizePath } from "../../src/parse/entities";
import { sectionUnits, splitSections } from "../../src/parse/sections";

async function run(md: string, splitChars = 6000) {
  const { tree } = cleanMdx(md, { pagePath: "p", snippets: new Map() });
  const sections = await splitSections(tree, { path: "p", title: "T" }, { splitChars });
  return extractEntities(sectionUnits(tree), sections);
}

describe("extractEntities", () => {
  it("parses a Structure table with optional and nullable markers", async () => {
    const { objects } = await run("### Channel Object\n\n###### Channel Structure\n\n| Field | Type | Description |\n|-|-|-|\n| id | snowflake | the id |\n| topic? | ?string | topic \* |");
    expect(objects[0].name).toBe("Channel");
    expect(objects[0].sectionId).toBe("p#channel-object");
    expect(objects[0].fields[1]).toMatchObject({ name: "topic", optional: true, type: "string", nullable: true, description: "topic", footnotes: ["*"] });
  });
  it("parses endpoints with params", async () => {
    const { endpoints } = await run('## Create Message\n\n<Route method="POST">/channels/\\{channel.id\\}/messages</Route>\n\n###### JSON Params\n\n| Field | Type |\n|-|-|\n| content | string |');
    expect(endpoints[0]).toMatchObject({ name: "Create Message", method: "POST", pathTemplate: "/channels/{channel.id}/messages", normalizedPath: "/channels/{}/messages", sectionId: "p#create-message" });
    expect(endpoints[0].params[0]).toMatchObject({ name: "JSON Params", columns: ["Field", "Type"], rows: [["content", "string"]] });
  });
  it("treats other tables as enums owned by the enclosing object", async () => {
    const { enums } = await run("### Channel Object\n\n###### Channel Types\n\n| Type | ID | Description |\n|-|-|-|\n| GUILD_TEXT | 0 | text |");
    expect(enums[0]).toMatchObject({ name: "Channel Types", ownerObject: "Channel", columns: ["Type", "ID", "Description"], rows: [["GUILD_TEXT", "0", "text"]] });
  });
  it("puts footnote markers on name and type cells into footnotes", async () => {
    const { objects } = await run("### X Object\n\n###### X Structure\n\n| Field | Type | Description |\n|-|-|-|\n| a\* | string \*\* | d |");
    expect(objects[0].fields[0]).toMatchObject({ name: "a", type: "string", footnotes: ["*", "**"] });
  });
  it("skips a malformed structure table with a problem", async () => {
    const r = await run("### X Object\n\n###### X Structure\n\n| Foo |\n|-|\n| a |\n\n### Y Object\n\n###### Y Structure\n\n| Field | Type | Description |\n|-|-|-|\n| b | int | d |");
    expect(r.problems.length).toBe(1);
    expect(r.objects.map((o) => o.name)).toEqual(["Y"]);
  });
});

describe("sectionId with split sections", () => {
  it("gives each entity the part that holds its table, even with a shared header row", async () => {
    const tbl = (k: string) => `| Field | Type | Description |
|-|-|-|
| ${k} | int | d |`;
    const src = `### X Object

###### X Structure

${tbl("a")}

###### First Flags

${tbl("b")}

###### Second Flags

${tbl("c")}`;
    const r = await run(src, 120);
    expect(r.objects[0].sectionId).toBe("p#x-object");
    expect(r.enums.map((e) => [e.name, e.sectionId])).toEqual([
      ["First Flags", "p#x-object~2"],
      ["Second Flags", "p#x-object~3"],
    ]);
  });
});

describe("normalizePath", () => {
  it("normalizes paths", () => {
    expect(normalizePath("https://discord.com/api/v10/channels/123/messages?limit=5")).toBe("/channels/{}/messages");
    expect(normalizePath("/channels/{id}/messages/")).toBe("/channels/{}/messages");
    expect(normalizePath("/channels/{channel.id}/messages")).toBe("/channels/{}/messages");
    expect(normalizePath("/Users/@me")).toBe("/users/@me");
    expect(normalizePath("/api/v10")).toBe("/");
  });
});
