import type { Root } from "mdast";
import { toMarkdown } from "./mdx";
import { pageUrl } from "./navigation";
import { sectionUnits } from "./sections";
import type { MdNode, ParsedSection, UpdateMeta } from "./types";

export interface ChangelogEntry {
  /** anchor of the entry's H2 section */
  id: string;
  /** YYYY-MM-DD (UTC) */
  date: string;
  tags: string[];
  title: string;
  description: string;
  markdown: string;
  /** absolute http(s) URLs found in the body, deduped, in order */
  links: string[];
  url: string;
}

const updateOf = (n: MdNode): UpdateMeta | undefined => (n.type === "heading" ? (n.data?.update as UpdateMeta | undefined) : undefined);

function collectLinks(nodes: MdNode[], into: string[]): void {
  for (const n of nodes) {
    if ((n.type === "link" || n.type === "definition") && typeof n.url === "string" && /^https?:\/\//i.test(n.url) && !into.includes(n.url)) into.push(n.url);
    if (Array.isArray(n.children)) collectLinks(n.children, into);
  }
}

function isoDate(label: string): string | null {
  const d = new Date(`${label} UTC`);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Entries of a change-log page, newest first. Each `<Update>` is an H2 carrying `data.update` (see cleanMdx);
 * its body is every top-level block up to the next Update. `sections` are the page's sections from `splitSections`.
 */
export function extractChangelog(tree: Root, sections: ParsedSection[], pagePath: string): { entries: ChangelogEntry[]; problems: string[] } {
  const entries: ChangelogEntry[] = [];
  const problems: string[] = [];
  const kids = tree.children as MdNode[];
  const units = sectionUnits(tree);

  for (let i = 0; i < kids.length; i++) {
    const meta = updateOf(kids[i]);
    if (!meta) continue;
    let end = i + 1;
    while (end < kids.length && !updateOf(kids[end])) end++;
    const body = kids.slice(i + 1, end).filter((n) => n.type !== "manualAnchor");

    const date = isoDate(meta.label);
    if (!date) {
      problems.push(`changelog: unparseable date label "${meta.label}"; entry skipped`);
      continue;
    }
    const ord = units.findIndex((u) => u.heading === kids[i]);
    const id = sections.find((s) => s.ord === ord && s.part === 1)?.anchor ?? "";
    if (!id) {
      problems.push(`changelog: no section for entry "${meta.label}"; entry skipped`);
      continue;
    }
    const markdown = toMarkdown({ type: "root", children: body } as unknown as Root).trim();
    const firstLine = markdown.split("\n").find((l) => l.trim() !== "");
    const links: string[] = [];
    collectLinks(body, links);
    entries.push({
      id,
      date,
      tags: meta.tags,
      title: meta.rssTitle?.trim() || (firstLine ? firstLine.replace(/^#+\s*/, "").trim() : meta.label),
      description: meta.rssDescription ?? "",
      markdown,
      links,
      url: pageUrl(pagePath, id),
    });
  }
  // newest first; Array.prototype.sort is stable, so same-day entries keep page order
  return { entries: entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)), problems };
}
