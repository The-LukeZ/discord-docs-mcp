import type { Navigation } from "./types";

const LABEL_KEYS = ["tab", "group", "anchor", "dropdown", "item"] as const;
const BASE_URL = "https://docs.discord.com/developers/";

function normalizePath(p: string): string {
  return p.replace(/^\/+/, "").replace(/^developers\/?/, "").replace(/\.mdx$/, "");
}

export function pagePathFromRepoPath(repoPath: string): string {
  return normalizePath(repoPath);
}

export function pageUrl(pagePath: string, anchor?: string): string {
  return BASE_URL + pagePath + (anchor ? `#${anchor}` : "");
}

export function parseNavigation(docsJson: string): Navigation {
  const doc = JSON.parse(docsJson) as { navigation?: unknown; redirects?: unknown };
  const breadcrumbs = new Map<string, string[]>();

  const walk = (node: unknown, crumbs: string[]): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, crumbs);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    let next = crumbs;
    for (const key of LABEL_KEYS) {
      const label = obj[key];
      if (typeof label === "string" && label.length > 0) {
        next = [...next, label];
        break;
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === "pages" && Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string") {
            const page = normalizePath(entry);
            if (!breadcrumbs.has(page)) breadcrumbs.set(page, next);
          } else walk(entry, next);
        }
      } else if (value && typeof value === "object") walk(value, next);
    }
  };
  walk(doc.navigation, []);

  const redirects: Navigation["redirects"] = [];
  if (Array.isArray(doc.redirects)) {
    for (const r of doc.redirects as Array<Record<string, unknown>>) {
      if (typeof r?.source === "string" && typeof r?.destination === "string") {
        redirects.push({ source: normalizePath(r.source), destination: normalizePath(r.destination) });
      }
    }
  }
  return { breadcrumbs, redirects };
}
