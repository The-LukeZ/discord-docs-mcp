export interface Navigation {
  /** page path (no "developers/" prefix, no .mdx) -> label trail */
  breadcrumbs: Map<string, string[]>;
  redirects: Array<{ source: string; destination: string }>;
}
