/**
 * Heading text -> anchor, github-slugger rules (what docs.discord.com links use; verified against
 * every `/developers/<path>#<anchor>` link in test/unit/anchors-corpus.test.ts):
 * lowercase, drop everything that is not a letter, number, underscore, hyphen or whitespace,
 * then turn each whitespace character into "-" (no collapsing, so "A & B" -> "a--b").
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Per-page slug allocator; repeats get `-1`, `-2`, ... (github-slugger style). */
export function createSlugger(): (text: string) => string {
  const used = new Set<string>();
  const counts = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    let out = base;
    let n = counts.get(base) ?? 0;
    while (used.has(out)) out = `${base}-${++n}`;
    counts.set(base, n);
    used.add(out);
    return out;
  };
}
