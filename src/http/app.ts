import { Hono } from "hono";
import { readConfig } from "../config";
import { log } from "../log";
import { counts, getSnapshotInfo } from "../store/read";
import { isAuthorized } from "./auth";

export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/health", async (c) => {
    const db = c.env.DB;
    const now = new Date();
    const cfg = readConfig(c.env);
    const [info, state] = await Promise.all([
      getSnapshotInfo(db, now, cfg.staleAfterHours),
      db
        .prepare("SELECT last_success_at, last_run_outcome FROM refresh_state WHERE id = 1")
        .first<{ last_success_at: string | null; last_run_outcome: string | null }>(),
    ]);
    const lastSuccess = state?.last_success_at ?? null;
    const t = lastSuccess === null ? NaN : Date.parse(lastSuccess);
    const stale = Number.isNaN(t) || now.getTime() - t > cfg.staleAfterHours * 3600_000;
    const n = info ? await counts(db, info.id) : null;
    return c.json({
      commit: info?.commitSha ?? null,
      last_success_at: lastSuccess,
      last_run_outcome: state?.last_run_outcome ?? null,
      stale,
      counts: {
        pages: n?.pages ?? 0,
        sections: n?.sections ?? 0,
        endpoints: n?.endpoints ?? 0,
        objects: n?.objects ?? 0,
      },
    });
  });

  app.post("/admin/refresh", async (c) => {
    if (!(await isAuthorized(c.req.header("Authorization"), c.env.ADMIN_TOKEN))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const force = c.req.query("force") === "1";
    // A fresh epoch id never collides with an earlier manual run.
    const instanceId = `manual-${Date.now()}`;
    await c.env.REFRESH_WORKFLOW.create({ id: instanceId, params: { force } });
    log("refresh.manual", { instanceId, force });
    return c.json({ instanceId }, 202);
  });

  return app;
}
