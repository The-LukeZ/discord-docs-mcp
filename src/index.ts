import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// Stub: replaced by the real limiter in a later task.
export class GlobalLimiter extends DurableObject<Env> {}

// Stub: replaced by the real workflow adapter in a later task.
export class RefreshWorkflow extends WorkflowEntrypoint<Env> {
  async run(_event: WorkflowEvent<unknown>, _step: WorkflowStep): Promise<void> {}
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
