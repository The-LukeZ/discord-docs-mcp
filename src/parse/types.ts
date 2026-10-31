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
