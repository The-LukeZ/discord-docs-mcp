import type { SnapshotInfo } from "../store/read";

/** What every tool returns; the MCP layer maps `isError` onto the protocol's tool error flag. */
export type ToolResult = { text: string; isError: boolean };

export const DOCS_BASE = "https://docs.discord.com/developers/";
export const ATTRIBUTION = "Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.";

/** Append the index provenance (commit, time), the attribution and, when stale, the staleness warning. */
export function envelope(body: string, info: SnapshotInfo): string {
  let out = `${body}\n\n---\nindexed_commit: ${info.commitSha} | indexed_at: ${info.indexedAt}\n${ATTRIBUTION}`;
  if (info.stale) out += `\nWarning: index is stale (last successful refresh ${info.indexedAt}).`;
  return out;
}

/**
 * Take at most `cap` characters of `text` from `offset`, cutting at the last blank line inside the window (the
 * blank line itself is skipped by `nextOffset`), else at the last line break, else hard cutting (never inside a
 * surrogate pair). `nextOffset` is null when the rest fits. Always makes progress, whatever `cap`.
 */
export function truncate(text: string, offset: number, cap: number): { slice: string; nextOffset: number | null } {
  const start = Math.max(0, Math.trunc(offset));
  if (start >= text.length) return { slice: "", nextOffset: null };
  const end = start + Math.max(1, Math.trunc(cap));
  if (end >= text.length) return { slice: text.slice(start), nextOffset: null };

  const blank = text.lastIndexOf("\n\n", end);
  if (blank > start) return { slice: text.slice(start, blank), nextOffset: blank + 2 };

  // No blank line: prefer a line break so a table row is not split in half.
  const nl = text.lastIndexOf("\n", end - 1);
  if (nl > start) return { slice: text.slice(start, nl), nextOffset: nl + 1 };

  let cut = end;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  if (cut <= start) cut = Math.min(text.length, start + 2);
  return { slice: text.slice(start, cut), nextOffset: cut };
}

export interface Cursor {
  target: string;
  offset: number;
}

const MAX_CURSOR_CHARS = 1024;

export function encodeCursor(c: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ target: c.target, offset: c.offset }));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not a cursor made by `encodeCursor`. */
export function decodeCursor(s: string): Cursor | null {
  if (typeof s !== "string" || s === "" || s.length > MAX_CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const { target, offset } = v as Record<string, unknown>;
    if (typeof target !== "string" || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return null;
    return { target, offset };
  } catch {
    return null;
  }
}

/** Section id without its `~n` part suffix. */
export const baseId = (id: string): string => id.replace(/~\d+$/, "");

/** Public docs URL of a section id (`page#anchor`, a part suffix is ignored). */
export const docsUrl = (id: string): string => DOCS_BASE + baseId(id);

/** Collapse whitespace; with `max`, shorten to at most that many characters. */
export function oneLine(s: string, max?: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return max !== undefined && t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}

/** Make text safe inside a markdown table cell. */
export const cell = (s: string): string => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

export function mdTable(columns: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`;
  const body = rows.map((r) => line(columns.map((_, i) => r[i] ?? "")));
  return [line(columns), line(columns.map(() => "---")), ...body].join("\n");
}
