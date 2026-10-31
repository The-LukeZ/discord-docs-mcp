import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readConfig } from "../config";
import { limiterStub } from "../limit/limiter";
import { log } from "../log";
import { getSnapshotInfo } from "../store/read";
import { ATTRIBUTION, type ToolResult } from "./format";
import { getSectionTool, lookupEndpointTool, lookupEnumTool, lookupObjectTool, recentChangesTool, searchDocsTool } from "./tools";

const GENERIC_ERROR = "Internal error. Please try again later.";
const CACHE_TTL_SECONDS = 86_400;
/** Bump when tool output formatting changes, so entries cached by older code are never served. */
export const CACHE_VERSION = "v1";

/**
 * Cache key URL: https://cache.internal/<commitSha>/<snapshotId>/<version>/<tool>/<argsDigest>.
 * The snapshot id keeps two snapshots of the same commit apart; the version isolates code changes.
 */
export function toolCacheUrl(
  info: { commitSha: string; id: string },
  tool: string,
  digest: string,
  version: string = CACHE_VERSION,
): string {
  const seg = encodeURIComponent;
  return `https://cache.internal/${seg(info.commitSha)}/${seg(info.id)}/${seg(version)}/${seg(tool)}/${digest}`;
}

/** Recursively sort object keys and trim strings, so equivalent argument objects serialize identically. */
function normalize(v: unknown): unknown {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, normalize(x)]),
    );
  }
  return v;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const errorClass = (e: unknown): string => (e instanceof Error && /^\w{1,40}$/.test(e.name) ? e.name : typeof e);

/**
 * Every tool call goes through here: (1) the global limiter, (2) the response cache, (3) the tool, (4) one log line.
 * No request object or header reaches this function, the limiter or the tools.
 *
 * Failure policy:
 * - A limiter failure fails closed: the caller gets the generic error and the tool does not run, so a broken
 *   limiter can never let uncached traffic past the cap.
 * - A cache failure (read, write, snapshot lookup) is logged and ignored: the tool runs uncached.
 * - A tool exception becomes the generic error. Only the tool name and the error's class name are logged, never
 *   its message or stack.
 *
 * `limiterName` is "global" in production; tests pass a unique name for isolated counters.
 */
export async function guard(
  env: Env,
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<ToolResult>,
  limiterName = "global",
): Promise<ToolResult> {
  const started = Date.now();
  let cached = false;
  let result: ToolResult;
  try {
    const cfg = readConfig(env);
    const verdict = await limiterStub(env, limiterName).consume(started, { perMinute: cfg.capPerMinute, perDay: cfg.capPerDay });
    if (!verdict.allowed) {
      const cap = verdict.window === "minute" ? cfg.capPerMinute : cfg.capPerDay;
      result = { text: `Usage cap reached (${cap} calls per ${verdict.window}). Retry in ${verdict.retryAfterSeconds} seconds.`, isError: true };
    } else {
      // A stale index is never cached: its responses carry a time-dependent warning.
      let cacheKey: Request | null = null;
      try {
        const info = await getSnapshotInfo(env.DB, new Date(), cfg.staleAfterHours);
        if (info && !info.stale) {
          const digest = await sha256Hex(JSON.stringify(normalize(args)));
          cacheKey = new Request(toolCacheUrl(info, tool, digest));
        }
      } catch (e) {
        log("cache_error", { tool, op: "key", errorClass: errorClass(e) });
      }

      let hit: ToolResult | null = null;
      if (cacheKey) {
        try {
          const res = await caches.default.match(cacheKey);
          if (res) hit = { text: ((await res.json()) as { text: string }).text, isError: false };
        } catch (e) {
          log("cache_error", { tool, op: "match", errorClass: errorClass(e) });
        }
      }

      if (hit) {
        cached = true;
        result = hit;
      } else {
        result = await fn();
        if (cacheKey && !result.isError) {
          try {
            await caches.default.put(
              cacheKey,
              new Response(JSON.stringify({ text: result.text }), {
                headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_TTL_SECONDS}` },
              }),
            );
          } catch (e) {
            log("cache_error", { tool, op: "put", errorClass: errorClass(e) });
          }
        }
      }
    }
  } catch (e) {
    log("tool_error", { tool, errorClass: errorClass(e) });
    result = { text: GENERIC_ERROR, isError: true };
  }
  log("tool", { tool, args, ms: Date.now() - started, cached, isError: result.isError });
  return result;
}

const INSTRUCTIONS = [
  "Search and read the official Discord developer documentation (docs.discord.com/developers), indexed from the current main branch of discord/discord-api-docs.",
  "Use lookup_endpoint, lookup_object and lookup_enum when you already know the name, route or identifier. Use search_docs for open questions. Use get_section after a search when a snippet is not enough. Use recent_changes to see what Discord changed lately.",
  "Every response states the indexed commit and time, and every content result carries its docs.discord.com URL.",
  ATTRIBUTION,
].join("\n\n");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const toMcp = (r: ToolResult) => ({ content: [{ type: "text" as const, text: r.text }], isError: r.isError });

export function createServer(env: Env, limiterName = "global"): McpServer {
  const server = new McpServer({ name: "discord-docs", version: "0.0.1" }, { instructions: INSTRUCTIONS });
  const g = (tool: string, args: Record<string, unknown>, fn: () => Promise<ToolResult>) => guard(env, tool, args, fn, limiterName);
  const cfg = () => readConfig(env);

  server.registerTool(
    "search_docs",
    {
      description:
        'Full-text search over the Discord developer documentation. Prefer this for open questions ("how do I ...", "what does ... do") and when you do not know the exact name. If you already know an endpoint, object or enum name, use lookup_endpoint, lookup_object or lookup_enum instead. Identifiers such as GUILD_MEMBERS, rate_limit_per_user or /channels/{channel.id}/messages work as queries. Results give a section_id; use get_section to read the full text when a snippet is not enough.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("Search text or an identifier."),
        limit: z.number().int().min(1).max(20).optional().describe("Maximum results. Default 8, maximum 20."),
        area: z.string().max(100).optional().describe("Optional top-level area filter, for example resources, interactions or discord-social-sdk."),
      }),
      annotations: READ_ONLY,
    },
    (a) => g("search_docs", a, () => searchDocsTool(env.DB, cfg(), a)).then(toMcp),
  );

  server.registerTool(
    "get_section",
    {
      description:
        "Read the full cleaned Markdown of one documentation section, by section_id (from search_docs or a lookup) or by a docs.discord.com URL with or without an anchor. A page URL without an anchor returns the page outline plus its first sections. Use it after search_docs when a snippet is not enough. Long sections are cut and return a cursor: to continue, send that cursor together with the same section_id or url you used before; a cursor alone does not work.",
      inputSchema: z.object({
        section_id: z.string().max(500).optional().describe("Section ID such as resources/channel#get-channel. Give this or url."),
        url: z.string().max(1000).optional().describe("A docs.discord.com/developers URL, with or without #anchor. Give this or section_id."),
        cursor: z.string().max(500).optional().describe("Continuation cursor from a previous cut response. Send it with the same section_id or url."),
      }),
      annotations: READ_ONLY,
    },
    (a) => g("get_section", a, () => getSectionTool(env.DB, cfg(), a)).then(toMcp),
  );

  server.registerTool(
    "lookup_endpoint",
    {
      description:
        'Look up a Discord REST endpoint by name ("Get Channel"), by path ("/channels/{channel.id}/messages") or by "METHOD path" ("POST /channels/123/messages"). Path parameters can be written in any form. Returns method, path, description, parameter tables and URL; the exact match first, then up to 5 near matches. Prefer this over search_docs when you know the endpoint.',
      inputSchema: z.object({
        query: z.string().min(1).max(500).describe("Endpoint name, path, or METHOD path."),
      }),
      annotations: READ_ONLY,
    },
    (a) => g("lookup_endpoint", a, () => lookupEndpointTool(env.DB, cfg(), a)).then(toMcp),
  );

  server.registerTool(
    "lookup_object",
    {
      description:
        'Look up a Discord object (data structure) by name, for example "Channel" or "Message Component". Returns the parsed field list (name, type, optional and nullable flags, description), related enums and flags with their section IDs, and the URL. Prefer this over search_docs when you know the object name.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe("Object name, for example Channel."),
      }),
      annotations: READ_ONLY,
    },
    (a) => g("lookup_object", a, () => lookupObjectTool(env.DB, cfg(), a)).then(toMcp),
  );

  server.registerTool(
    "lookup_enum",
    {
      description:
        'Look up a Discord enum or flags table by name, for example "Channel Types", "Intents" or "Permission Flags". Returns the table rows with their original columns, the owning object and the URL. Prefer this over search_docs when you know the enum name.',
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe("Enum or flags table name, for example Channel Types."),
      }),
      annotations: READ_ONLY,
    },
    (a) => g("lookup_enum", a, () => lookupEnumTool(env.DB, cfg(), a)).then(toMcp),
  );

  server.registerTool(
    "recent_changes",
    {
      description:
        'List recent changes to the Discord developer documentation, newest first: Discord\'s own changelog entries and/or section-level edits detected between index refreshes. Use it to answer "what changed lately". All inputs are optional.',
      inputSchema: z.object({
        since: z.string().max(40).optional().describe("Start date, for example 2026-10-01. Default: 30 days ago."),
        source: z.enum(["changelog", "docs", "both"]).optional().describe("changelog = Discord's changelog, docs = detected section edits, both (default)."),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum entries. Default 20, maximum 100."),
      }),
      annotations: READ_ONLY,
    },
    (a) => g("recent_changes", a, () => recentChangesTool(env.DB, cfg(), a)).then(toMcp),
  );

  return server;
}
