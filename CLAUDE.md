# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A public, authless MCP server (Cloudflare Worker) serving Discord's developer docs. A daily Workflow indexes `discord/discord-api-docs` into D1; read-only MCP tools query that index. See [README.md](README.md) for the public endpoint, tool list and deploy steps.

## Commands

Package manager is pnpm.

- `pnpm test`: all vitest projects
- `pnpm run test:unit`: `test/unit`, plain node
- `pnpm run test:worker`: `test/worker`, runs in workerd via `@cloudflare/vitest-plugin` with an in-memory D1
- Single file: `pnpm exec vitest run --project unit test/unit/page.test.ts` (use `--project worker` for worker tests); add `-t "name"` to filter by test name
- `pnpm run typecheck`: `tsc --noEmit` over src, test and scripts
- `pnpm run types`: regenerates `worker-configuration.d.ts`. Rerun after editing `wrangler.jsonc` (bindings, vars).
- `pnpm exec wrangler dev`: local run. Needs `GITHUB_FETCH_TOKEN` and `ADMIN_TOKEN` in an uncommitted `.dev.vars`.
- `scripts/fetch-corpus.ts`: re-pins the test fixture `test/fixtures/corpus.json` from GitHub (optional `GITHUB_FETCH_TOKEN` env to avoid rate limits)

## Architecture

Two halves joined by a D1 database: a write path (refresh) and a read path (MCP tools).

**Entry** ([src/index.ts](src/index.ts)): Hono app for `fetch`, `scheduled` handler that starts the daily refresh, and re-exports of the `RefreshWorkflow` and `GlobalLimiter` classes (they must be exported from the entry module for wrangler bindings and DO migrations).

**Write path** (`src/refresh/`, `src/parse/`, `src/store/write.ts`):

- [src/refresh/run.ts](src/refresh/run.ts) `runRefresh` is the whole refresh as a sequence of named steps (`resolve-head`, `fetch-tree`, `fetch:*`, `parse:<n>`, `copy-unchanged`, `publish`, `cleanup`, `record-failure`). It talks to a `StepRunner` so production uses Workflow `step.do` (durable, retried, results replayed) and tests can use a plain runner. Rules: every step body is idempotent, state crosses steps only via small JSON-serializable step results, and all D1 writes and network calls happen inside steps.
- Incremental: the new tree is diffed against the current snapshot by blob sha. Only changed pages (plus importers of changed snippets, or everything if `docs.json` changed or `force`) are re-parsed; the rest are copied via `copyPages`.
- Snapshots are atomic: a `building` snapshot is filled, then `publishSnapshot` does a compare-and-swap on `refresh_state.current_snapshot`. Readers only ever see the live snapshot. Failures mark the snapshot failed and never move the pointer.
- Parsing pipeline: `mdx.ts` (remark + MDX cleanup, inlines snippets) -> `sections.ts` (split into sections, long ones into parts, ids from `anchors.ts`) -> `entities.ts` (endpoints, objects, enums) and `changelog.ts`. `navigation.ts` derives breadcrumbs/redirects from `docs.json`. `page.ts` orchestrates; entity and changelog failures degrade to a recorded problem, not a failed page.
- `recent_changes` data comes from section-level diffs between snapshots (`diffSections` in run.ts) plus parsed changelog entries.

**Read path** (`src/mcp/`, `src/search/`, `src/store/read.ts`):

- [src/mcp/server.ts](src/mcp/server.ts) registers the six tools; all go through `guard()`: global rate limit (Durable Object `GlobalLimiter`, fails closed) -> Cache API keyed by commit/snapshot/`CACHE_VERSION`/tool/args digest -> tool -> log line. Bump `CACHE_VERSION` when tool output formatting changes. Stale indexes are never cached.
- Tool bodies are in [src/mcp/tools.ts](src/mcp/tools.ts), output formatting (and `ATTRIBUTION`) in `format.ts`. Search is D1 FTS with identifier-aware query building in `src/search/query.ts`.
- [src/http/app.ts](src/http/app.ts): `/mcp` (stateless `createMcpHandler`, fresh server per request), `/health`, `/privacy`, and bearer-protected `POST /admin/refresh[?force=1]`.

**Config**: tunables are string `vars` in `wrangler.jsonc`, read through `readConfig` in [src/config.ts](src/config.ts) with defaults. Secrets (`GITHUB_FETCH_TOKEN`, `ADMIN_TOKEN`) are declared by hand in [src/env.d.ts](src/env.d.ts) because `wrangler types` does not generate them.

## Conventions and gotchas

- Privacy is a design constraint: logs (`src/log.ts`) hold tool names and query text only. No request object, header or IP may reach `guard`, the limiter or the tools.
- Tests use a pinned docs corpus in `test/fixtures/corpus.json` (CC-BY-SA content, not MIT). Worker tests index it with `indexCorpus` in `test/worker/corpus-index.ts`; it is slow (parses every page in workerd), so call it once per file in `beforeAll` with a long timeout. Real GitHub fetches are not covered by automated tests (`test/worker/fake-github.ts` stands in).
- Schema changes go in a new numbered file under `migrations/`; the worker test setup applies them to the test D1 automatically.
- The refresh must stay single-flight: cron instance ids are `cron-YYYY-MM-DD`, manual ones `manual-<epoch ms>`, and `cleanup` must not overlap another run's fetch.
- Workflows and the D1/DO setup are pinned to the EU jurisdiction; local workerd does not implement DO jurisdictions.
