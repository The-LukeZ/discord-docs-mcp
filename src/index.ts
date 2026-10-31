import { createApp } from "./http/app";
import { startCronRefresh } from "./refresh/workflow";

export { RefreshWorkflow } from "./refresh/workflow";
// Re-exported from the entry module so the wrangler Durable Object migration finds the class.
export { GlobalLimiter } from "./limit/limiter";

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  async scheduled(controller, env, _ctx) {
    await startCronRefresh(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
