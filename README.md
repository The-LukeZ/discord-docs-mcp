# discord-docs-mcp

Public, authless remote MCP server on Cloudflare Workers serving Discord's developer docs (D1 + FTS5, Workflows, a Durable Object limiter).

Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.

> [!TIP]
> Discord hosts an official MCP server for its docs at <https://docs.discord.com/mcp>. It offers a generic documentation search and a read-only virtual filesystem over the pages. This project is an independent alternative, not a replacement. It adds structured lookups for endpoints, objects and enums, identifier-aware search, stable section ids, change tracking between refreshes, and answers pinned to a docs commit. If you only need general docs search, use the official server. This one is just more powerful.

## Requirements

- A Cloudflare account on the **Workers Paid** plan. The refresh runs as a Workflow, and the Free plan allows only 10 ms of CPU and 50 external subrequests per invocation, so the refresh cannot run there.
- Node.js and pnpm.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | 302 redirect to this repository |
| `/mcp` | The MCP endpoint (Streamable HTTP, no authentication) |
| `/health` | Index status as JSON, see [Checking health](#checking-health) |
| `/privacy` | Privacy page |
| `POST /admin/refresh` | Start a refresh (bearer `ADMIN_TOKEN`) |

## Setup

```bash
pnpm install
```

### Create the EU D1 database

```bash
pnpm dlx wrangler@latest d1 create discord-docs --jurisdiction=eu
```

Paste the returned `database_id` into `wrangler.jsonc`. Confirm in the dashboard that the database shows jurisdiction EU. A database created without `eu` must be deleted and recreated.

`PUBLIC_ORIGIN` in `wrangler.jsonc` already holds the production origin `https://bugcord-mcp.dev` and is currently informational only; change it only if you deploy under another origin. Apply migrations with `pnpm exec wrangler d1 migrations apply discord-docs --remote`, and set secrets `GITHUB_FETCH_TOKEN` and `ADMIN_TOKEN`.

## Scripts

- `pnpm test` runs all vitest projects (`unit` on node, `worker` on workerd via `@cloudflare/vitest-plugin`)
- `pnpm run test:unit`, `pnpm run test:worker`
- `pnpm run typecheck`
- `pnpm run types` regenerates `worker-configuration.d.ts` (rerun after editing `wrangler.jsonc`)

## Operations

### Secrets

The Worker needs two secrets. They are Worker secrets only: never put them in `wrangler.jsonc`, the repo or a `.dev.vars` you commit.

```bash
pnpm exec wrangler secret put GITHUB_FETCH_TOKEN   # read-only GitHub token used to read discord/discord-api-docs
pnpm exec wrangler secret put ADMIN_TOKEN          # bearer token for POST /admin/refresh
```

If `ADMIN_TOKEN` is not set, `/admin/refresh` rejects every request.

### First deploy and baseline

After the first deploy the index is empty (`/health` reports `stale: true` and zero counts). Build the baseline once with a manual refresh:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-worker>/admin/refresh
```

The response is `202 {"instanceId":"manual-<epoch ms>"}`. Add `?force=1` to re-parse the already indexed commit. After that, a daily cron (04:17 UTC) refreshes the index; it uses the instance id `cron-YYYY-MM-DD`, so a day never runs twice.

### Workflow failure notification

Enable a Cloudflare notification for Workflow failures (dashboard: Notifications, add a Workflows notification for failed instances) so a failed refresh does not go unnoticed. A failed run never changes what readers see; the previous snapshot stays live.

### Checking health

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

`stale` is `true` when there has been no successful refresh for `STALE_AFTER_HOURS` (72) or there is none yet. `last_run_outcome` is `published`, `noop` or `failed`.

### Manual end-to-end check

The automated tests do not cover a real GitHub fetch. Run this once locally with your secrets in `.dev.vars` (`GITHUB_FETCH_TOKEN`, `ADMIN_TOKEN`):

```bash
pnpm exec wrangler dev
curl -X POST localhost:8787/admin/refresh -H "Authorization: Bearer $ADMIN_TOKEN"
# wait until GET localhost:8787/health shows a commit
pnpm dlx @modelcontextprotocol/inspector   # connect to http://localhost:8787/mcp (Streamable HTTP) and run search_docs with GUILD_MEMBERS
```

Expected: Gateway Intents is in the top 3 results. The public MCP URL is `https://bugcord-mcp.dev/mcp`. Local workerd does not implement Durable Object jurisdictions, so locally the limiter runs without the `eu` jurisdiction; on Cloudflare it is always `eu`.
