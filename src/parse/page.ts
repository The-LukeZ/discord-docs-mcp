import type { Root } from "mdast";
import { toString } from "mdast-util-to-string";
import { extractChangelog, type ChangelogEntry } from "./changelog";
import { extractEntities } from "./entities";
import { cleanMdx } from "./mdx";
import { pagePathFromRepoPath, pageUrl } from "./navigation";
import { sectionUnits, splitSections } from "./sections";
import type { Navigation, ParsedEndpoint, ParsedEnum, ParsedObject, ParsedSection } from "./types";

export type { ChangelogEntry };

export interface ParsedPage {
  meta: { path: string; title: string; sidebarTitle?: string; description?: string; breadcrumb: string[]; url: string };
  sections: ParsedSection[];
  endpoints: ParsedEndpoint[];
  objects: ParsedObject[];
  enums: ParsedEnum[];
  changelog: ChangelogEntry[];
  snippetDeps: string[];
  problems: string[];
}

export interface PageContext {
  /** repo path -> source */
  snippets: Map<string, string>;
  nav: Navigation;
  splitChars: number;
}

const CHANGELOG_PATH = "change-log";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0];

/**
 * Parse one docs page. Sections are required; entity extraction and changelog parsing each run in their
 * own try/catch, so a failure there keeps the sections and records a problem instead.
 */
export async function parsePage(file: { path: string; content: string }, ctx: PageContext): Promise<ParsedPage> {
  const path = pagePathFromRepoPath(file.path);
  const clean = cleanMdx(file.content, { pagePath: path, snippets: ctx.snippets });
  const { frontmatter, tree } = clean;
  const h1 = (tree.children as Array<{ type: string; depth?: number }>).find((n) => n.type === "heading" && n.depth === 1);
  const title = frontmatter.title?.trim() || (h1 && toString(h1 as never).trim()) || path;

  const sections = await splitSections(tree, { path, title }, { splitChars: ctx.splitChars });
  const problems = [...clean.problems];
  const page: ParsedPage = {
    meta: { path, title, breadcrumb: ctx.nav.breadcrumbs.get(path) ?? [], url: pageUrl(path) },
    sections,
    endpoints: [],
    objects: [],
    enums: [],
    changelog: [],
    snippetDeps: [...new Set(clean.snippetDeps)].sort(),
    problems,
  };
  if (frontmatter.sidebarTitle !== undefined) page.meta.sidebarTitle = frontmatter.sidebarTitle;
  if (frontmatter.description !== undefined) page.meta.description = frontmatter.description;

  try {
    const e = extractEntities(sectionUnits(tree), sections);
    page.endpoints = e.endpoints;
    page.objects = e.objects;
    page.enums = e.enums;
    problems.push(...e.problems);
  } catch (err) {
    problems.push(`entity extraction failed (${path}): ${reason(err)}`);
  }

  if (path === CHANGELOG_PATH) {
    try {
      const c = extractChangelog(tree as Root, sections, path);
      page.changelog = c.entries;
      problems.push(...c.problems);
    } catch (err) {
      problems.push(`changelog parsing failed (${path}): ${reason(err)}`);
    }
  }
  return page;
}
