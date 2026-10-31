import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { readConfig } from "../config";
import { log } from "../log";
import { createGitHubSource } from "./github";
import { runRefresh, type RunSummary, type StepRunner } from "./run";

/** Retry and timeout policy of every refresh step. */
const STEP_CONFIG = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** Refresh run as a Cloudflare Workflow: each `runRefresh` step becomes a durable, retried `step.do`. */
export class RefreshWorkflow extends WorkflowEntrypoint<Env, { force: boolean }> {
  async run(event: WorkflowEvent<{ force: boolean }>, step: WorkflowStep): Promise<RunSummary> {
    const { env } = this;
    const runner: StepRunner = {
      // Step names and results come from run.ts, which keeps results small and JSON-serializable.
      do: <T>(name: string, fn: () => Promise<T>): Promise<T> =>
        step.do(name, STEP_CONFIG, fn as () => Promise<any>) as Promise<T>,
    };
    const deps = {
      db: env.DB,
      source: createGitHubSource(env.GITHUB_FETCH_TOKEN ?? ""),
      splitChars: readConfig(env).sectionSplitChars,
      now: () => new Date(),
    };
    return runRefresh(deps, { runId: event.instanceId, force: event.payload?.force === true }, runner);
  }
}

/** `cron-YYYY-MM-DD` (UTC): one scheduled instance per day, which keeps the refresh single-flight. */
export const cronInstanceId = (at: Date): string => `cron-${at.toISOString().slice(0, 10)}`;

/** Start the daily scheduled refresh. An instance for the same UTC day that already exists is not an error. */
export async function startCronRefresh(env: Env, at: Date): Promise<void> {
  const id = cronInstanceId(at);
  try {
    await env.REFRESH_WORKFLOW.create({ id, params: { force: false } });
    log("refresh.scheduled", { instanceId: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/already[ _.-]?exist/i.test(message)) throw err;
    log("refresh.schedule_skipped", { instanceId: id, reason: "already exists" });
  }
}
