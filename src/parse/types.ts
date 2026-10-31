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
  /** from `<a id="x"/>`: an extra anchor target that does not replace the heading slug */
  alias?: boolean;
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

export interface ParsedSection {
  /** `baseId` for part 1, `${baseId}~${part}` for later parts */
  id: string;
  /** `pagePath#anchor`, or `pagePath` for the intro */
  baseId: string;
  pagePath: string;
  /** first segment of pagePath */
  area: string;
  /** "" for the intro */
  anchor: string;
  heading: string;
  /** starts with the page title */
  headingPath: string[];
  level: 1 | 2 | 3;
  /** 1-based part number (long sections are split) */
  part: number;
  /** 0-based position of the section within the page; all parts of one section share it */
  ord: number;
  markdown: string;
  /** sha256 hex of `markdown` */
  contentHash: string;
  /** anchors of H4-H6 headings and stray manual anchors inside this part */
  subAnchors: string[];
}

/** Loose mdast node used by the section/entity code. */
export interface MdNode {
  type: string;
  [k: string]: any;
}

/** One H2/H3 (or the intro): its heading plus every block up to the next H2/H3. Unit i has `ord` i. */
export interface SectionUnit {
  level: 1 | 2 | 3;
  /** explicit `<ManualAnchor>` placed right before the heading, if any */
  manualAnchor?: string;
  /** heading node; null for the intro (the page title is used) */
  heading: MdNode | null;
  /** blocks after the heading; may contain H4-H6 headings and manualAnchor markers */
  body: MdNode[];
}

export interface ParamTable {
  name: string;
  columns: string[];
  rows: string[][];
}

export interface ParsedEndpoint {
  name: string;
  method: string;
  pathTemplate: string;
  normalizedPath: string;
  sectionId: string;
  params: ParamTable[];
}

export interface ParsedField {
  name: string;
  optional: boolean;
  type: string;
  nullable: boolean;
  description: string;
  footnotes: string[];
}

export interface ParsedObject {
  name: string;
  sectionId: string;
  fields: ParsedField[];
}

export interface ParsedEnum {
  name: string;
  sectionId: string;
  ownerObject: string | null;
  columns: string[];
  rows: string[][];
}
