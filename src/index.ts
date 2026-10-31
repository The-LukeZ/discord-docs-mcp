import { DurableObject } from "cloudflare:workers";
import { createApp } from "./http/app";
import { startCronRefresh } from "./refresh/workflow";

export { RefreshWorkflow } from "./refresh/workflow";

// Stub: replaced by the real limiter in a later task.
export class GlobalLimiter extends DurableObject<Env> {}

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  async scheduled(controller, env, _ctx) {
    await startCronRefresh(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
