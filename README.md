# discord-docs-mcp

A public, authless [MCP](https://modelcontextprotocol.io) server that gives AI assistants fast, precise access to [Discord's developer documentation](https://docs.discord.com/developers).

**Endpoint:** `https://bugcord-mcp.dev/mcp` (Streamable HTTP, no sign-in, no API key)

Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.

> [!TIP]
> Discord hosts an official MCP server for its docs at <https://docs.discord.com/mcp>. It offers a generic documentation search and a read-only virtual filesystem over the pages. This project is an independent alternative, not a replacement. It adds structured lookups for endpoints, objects and enums, identifier-aware search, stable section ids, change tracking between refreshes, and answers pinned to a docs commit. If you only need general docs search, use the official server. This one is just more powerful.

## Connect

Claude Code:

```bash
claude mcp add --transport http discord-docs https://bugcord-mcp.dev/mcp
```

Claude.ai and other clients with remote MCP support: add a custom connector with the URL `https://bugcord-mcp.dev/mcp` and no authentication.

Clients configured through JSON (the exact key names differ per client):

```json
{
  "mcpServers": {
    "discord-docs": { "type": "http", "url": "https://bugcord-mcp.dev/mcp" }
  }
}
```

## Tools

All tools are read-only. Every result that contains documentation includes its `docs.discord.com` URL, and every response states the docs commit it was built from (`indexed_commit`, `indexed_at`).

| Tool | Use it for |
| --- | --- |
| `search_docs` | Open questions and keyword search. Ranks exact identifiers (`GUILD_MEMBERS`, `rate_limit_per_user`) highly. |
| `get_section` | The full text of one section, by section id or `docs.discord.com` URL (including legacy `discord.com/developers/docs` links). Long sections page with a cursor. |
| `lookup_endpoint` | A REST endpoint by name (`Get Channel`), path, or `METHOD path`. Path parameters can be written in any form (`{channel.id}`, `123`). |
| `lookup_object` | An object's parsed field list and its related enums and flags. |
| `lookup_enum` | An enum or flag table with its original columns, for example `Channel Types` or `Permission Flags`. |
| `recent_changes` | Changelog entries and detected documentation changes since a date. |

Unknown ids and unmatched names return a "Not found" message with up to five suggestions, never an empty success.

## How it works

- A daily job reads the official [discord/discord-api-docs](https://github.com/discord/discord-api-docs) repository at a pinned commit, parses the pages into sections, endpoints, objects and enums, and publishes them as one atomic snapshot. A failed run never changes what readers see.
- Search runs on SQLite full-text search (Cloudflare D1), with exact-identifier lookups ranked ahead of text matches.
- Everything runs on Cloudflare Workers, with data and workflows pinned to the EU jurisdiction.
- `GET /health` reports the indexed commit, the last successful refresh and whether the index is stale (no successful refresh for 72 hours).

## Usage limits

The server is free and unauthenticated, so it enforces global caps shared by all callers: 300 tool calls per minute and 30,000 per UTC day. When a cap is reached, tool calls return an error that names the window and the retry time. Responses are cached per indexed commit for 24 hours.

## Privacy

No accounts and no stored personal data. Logs contain tool names and query text, never IP addresses, user agents or other client identifiers. Cloudflare processes IP addresses transiently to deliver requests. See `/privacy` on the running server.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Redirects to this repository |
| `/mcp` | The MCP endpoint |
| `/health` | Index status as JSON |
| `/privacy` | Privacy page |
| `POST /admin/refresh` | Start a refresh (operator only, bearer `ADMIN_TOKEN`) |

## Run your own

You do not need to; the public endpoint is free to use. If you want your own copy:

### Requirements

- A Cloudflare account on the **Workers Paid** plan. The refresh runs as a Workflow, and the Free plan allows only 10 ms of CPU and 50 external subrequests per invocation, so the refresh cannot run there.
- Node.js and pnpm.

### Setup

```bash
pnpm install
pnpm dlx wrangler@latest d1 create discord-docs --jurisdiction=eu
```

Paste the returned `database_id` into `wrangler.jsonc`. Confirm in the dashboard that the database shows jurisdiction EU; a database created without `eu` must be deleted and recreated. `PUBLIC_ORIGIN` in `wrangler.jsonc` holds the production origin and is currently informational only; change it if you deploy under another origin. Then apply migrations and set the two Worker secrets:

```bash
pnpm exec wrangler d1 migrations apply discord-docs --remote
pnpm exec wrangler secret put GITHUB_FETCH_TOKEN   # read-only GitHub token used to read discord/discord-api-docs
pnpm exec wrangler secret put ADMIN_TOKEN          # bearer token for POST /admin/refresh
```

Secrets are Worker secrets only: never put them in `wrangler.jsonc`, the repo or a `.dev.vars` you commit. If `ADMIN_TOKEN` is not set, `/admin/refresh` rejects every request.

### First deploy and baseline

After the first deploy the index is empty (`/health` reports `stale: true` and zero counts). Build the baseline once with a manual refresh:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-worker>/admin/refresh
```

The response is `202 {"instanceId":"manual-<epoch ms>"}`. Add `?force=1` to re-parse the already indexed commit. After that, a daily cron (04:17 UTC) refreshes the index; it uses the instance id `cron-YYYY-MM-DD`, so a day never runs twice.

Enable a Cloudflare notification for Workflow failures (dashboard: Notifications, add a Workflows notification for failed instances) so a failed refresh does not go unnoticed.

`GET /health` returns HTTP 200 whenever D1 is reachable, with JSON:

```json
{
  "commit": "<sha>",
  "last_success_at": "<ISO time>",
  "last_run_outcome": "published",
  "stale": false,
  "counts": { "pages": 0, "sections": 0, "endpoints": 0, "objects": 0 }
}
```

`last_run_outcome` is `published`, `noop` or `failed`.

### Local end-to-end check

The automated tests do not cover a real GitHub fetch. Run this once locally with your secrets in `.dev.vars` (`GITHUB_FETCH_TOKEN`, `ADMIN_TOKEN`):

```bash
pnpm exec wrangler dev
curl -X POST localhost:8787/admin/refresh -H "Authorization: Bearer $ADMIN_TOKEN"
# wait until GET localhost:8787/health shows a commit
pnpm dlx @modelcontextprotocol/inspector   # connect to http://localhost:8787/mcp (Streamable HTTP) and run search_docs with GUILD_MEMBERS
```

Expected: Gateway Intents is in the top 3 results. Local workerd does not implement Durable Object jurisdictions, so locally the limiter runs without the `eu` jurisdiction; on Cloudflare it is always `eu`.

## Development

- `pnpm test` runs all vitest projects (`unit` on node, `worker` on workerd via `@cloudflare/vitest-plugin`)
- `pnpm run test:unit`, `pnpm run test:worker`
- `pnpm run typecheck`
- `pnpm run types` regenerates `worker-configuration.d.ts` (rerun after editing `wrangler.jsonc`)

## License and attribution

The source code of this repository is released under the [MIT License](LICENSE). That license does not cover the documentation content the server serves. That content is Discord's developer documentation, licensed CC-BY-SA 4.0 (this includes the copy in `test/fixtures/corpus.json`), and this project is not affiliated with Discord.
