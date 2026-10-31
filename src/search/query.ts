import { normalizePath } from "../parse/entities";

/** At most this many tokens of a query reach FTS; the rest is dropped. */
export const MAX_QUERY_TOKENS = 32;
/** Longer tokens are cut; no identifier in the docs is anywhere near this long. */
const MAX_TOKEN_CHARS = 64;

const TOKEN = /[\p{L}\p{N}_]+/gu;

/**
 * Turn free text into an FTS5 MATCH expression. Only letters, digits and `_` survive and every token is wrapped
 * in double quotes, so no FTS syntax (operators, column filters, NEAR, `*`, quotes) can get through. Null when
 * the input has no token.
 */
export function toFtsQuery(input: string, mode: "and" | "or"): string | null {
  const tokens = (input.match(TOKEN) ?? []).slice(0, MAX_QUERY_TOKENS).map((t) => `"${t.slice(0, MAX_TOKEN_CHARS)}"`);
  if (tokens.length === 0) return null;
  return tokens.join(mode === "or" ? " OR " : " ");
}

const METHOD = /^(get|post|put|patch|delete)(?:\s+(\S.*))?$/i;
const looksLikePath = (s: string): boolean => !/\s/.test(s) && (s.startsWith("/") || /^https?:\/\//i.test(s));

/**
 * Read a query as an endpoint reference: `METHOD /path`, `/path` or a name such as "Get Channel". Paths are
 * normalized like stored endpoints (`{channel.id}` and numeric segments become `{}`). A bare method gives only
 * `method`; anything else is a `name`.
 */
export function parseEndpointQuery(q: string): { method?: string; path?: string; name?: string } {
  const s = q.trim().replace(/\s+/g, " ");
  if (s === "") return {};
  if (looksLikePath(s)) return { path: normalizePath(s) };
  const m = METHOD.exec(s);
  if (m) {
    if (m[2] === undefined) return { method: m[1].toUpperCase() };
    if (looksLikePath(m[2])) return { method: m[1].toUpperCase(), path: normalizePath(m[2]) };
  }
  return { name: s };
}
