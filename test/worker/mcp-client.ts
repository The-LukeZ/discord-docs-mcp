import { SELF } from "cloudflare:test";

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const BASE_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

/** Parse a JSON body or an SSE stream (`data:` lines) into the JSON-RPC messages it carries. */
export async function parseRpc(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const msgs = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
    return msgs.at(-1);
  }
  return text ? JSON.parse(text) : undefined;
}

type Fetcher = (req: Request) => Promise<Response>;
const viaSelf: Fetcher = (req) => SELF.fetch(req);

/** POST a JSON-RPC request to /mcp. `fetcher` lets a test target a differently configured app. */
export async function rpc(method: string, params: unknown, extraHeaders: Record<string, string> = {}, fetcher: Fetcher = viaSelf, id = 1) {
  const res = await fetcher(
    new Request("https://x/mcp", {
      method: "POST",
      headers: { ...BASE_HEADERS, ...extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  return { res, body: await parseRpc(res) };
}

export async function initialize(extraHeaders: Record<string, string> = {}, fetcher: Fetcher = viaSelf) {
  return rpc(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    extraHeaders,
    fetcher,
  );
}

export async function listTools(extraHeaders: Record<string, string> = {}, fetcher: Fetcher = viaSelf) {
  await initialize(extraHeaders, fetcher);
  const { body } = await rpc("tools/list", {}, extraHeaders, fetcher, 2);
  return body.result.tools as Array<{ name: string; description?: string; annotations?: Record<string, unknown>; inputSchema: any }>;
}

export async function callToolRaw(name: string, args: unknown, extraHeaders: Record<string, string> = {}, fetcher: Fetcher = viaSelf) {
  await initialize(extraHeaders, fetcher);
  return rpc("tools/call", { name, arguments: args }, extraHeaders, fetcher, 3);
}

export async function callTool(name: string, args: unknown, extraHeaders: Record<string, string> = {}, fetcher: Fetcher = viaSelf): Promise<McpToolResult> {
  const { body } = await callToolRaw(name, args, extraHeaders, fetcher);
  if (body.error) throw new Error(`rpc error: ${JSON.stringify(body.error)}`);
  return body.result as McpToolResult;
}
