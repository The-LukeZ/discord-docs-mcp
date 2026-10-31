import type { Root } from "mdast";

export interface Navigation {
  /** page path (no "developers/" prefix, no .mdx) -> label trail */
  breadcrumbs: Map<string, string[]>;
  redirects: Array<{ source: string; destination: string }>;
}

/** Marker left by `<ManualAnchor id="..." />`; consumed by the section splitter, never serialized. */
export interface ManualAnchor {
  type: "manualAnchor";
  id: string;
}

declare module "mdast" {
  interface RootContentMap {
    manualAnchor: ManualAnchor;
  }
  interface BlockContentMap {
    manualAnchor: ManualAnchor;
  }
}

export interface Frontmatter {
  title?: string;
  sidebarTitle?: string;
  description?: string;
}

export interface CleanResult {
  frontmatter: Frontmatter;
  /** mdast with no JSX left except manualAnchor markers */
  tree: Root;
  /** repo paths of snippets inlined (transitively) */
  snippetDeps: string[];
  problems: string[];
}

/** Stored on the H2 mdast node generated from `<Update>` as `data.update`. */
export interface UpdateMeta {
  label: string;
  tags: string[];
  rssTitle?: string;
  rssDescription?: string;
}
