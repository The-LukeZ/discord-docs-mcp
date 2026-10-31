# discord-docs-mcp

Public, authless remote MCP server on Cloudflare Workers serving Discord's developer docs (D1 + FTS5, Workflows, a Durable Object limiter).

Content: Discord Developer Documentation, CC-BY-SA 4.0. Not affiliated with Discord.

## Setup

```bash
npm install
```

### Create the EU D1 database (one time, operator)

```bash
npx wrangler@latest d1 create discord-docs --jurisdiction=eu
```

Paste the returned `database_id` into `wrangler.jsonc` (it currently holds the placeholder `00000000-0000-0000-0000-000000000000`). Confirm in the dashboard that the database shows jurisdiction EU. A database created without `eu` must be deleted and recreated.

Then set `PUBLIC_ORIGIN` in `wrangler.jsonc` to the deployed origin, apply migrations with `npx wrangler d1 migrations apply discord-docs --remote`, and set secrets `GITHUB_FETCH_TOKEN` and `ADMIN_TOKEN`.

## Scripts

- `npm test` runs all vitest projects (`unit` on node, `worker` on workerd via `@cloudflare/vitest-plugin`)
- `npm run test:unit`, `npm run test:worker`
- `npm run typecheck`
- `npm run types` regenerates `worker-configuration.d.ts` (rerun after editing `wrangler.jsonc`)
