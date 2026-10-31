import { SELF, env, introspectWorkflow } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { createApp } from "../../src/http/app";
import { isAuthorized } from "../../src/http/auth";
import { cronInstanceId, startCronRefresh } from "../../src/refresh/workflow";
import { indexCorpus } from "./corpus-index";

const AUTH = { Authorization: "Bearer test-admin-token" };
const post = (path: string, headers: Record<string, string> = {}) => SELF.fetch(`https://x${path}`, { method: "POST", headers });

interface Created {
  id?: string;
  params?: { force: boolean };
}
/** A stand-in for the Workflow binding that records `create` calls. */
function fakeWorkflow(create?: (opts: Created) => Promise<unknown>) {
  const calls: Created[] = [];
  const binding = {
    create: async (opts: Created) => {
      calls.push(opts);
      return create ? create(opts) : { id: opts.id };
    },
  };
  return { calls, env: { ...env, REFRESH_WORKFLOW: binding } as unknown as Env };
}

/** A no-op head for `resolve-head`, so a real workflow instance ends after one step without any network. */
const noopHead = (sha: string) => ({ sha, startedAt: "2026-10-31T00:00:00.000Z", baseSnapshot: 1, baseCommit: sha, noop: true });

describe("isAuthorized", () => {
  it("accepts only the exact Bearer token", async () => {
    expect(await isAuthorized("Bearer secret", "secret")).toBe(true);
    expect(await isAuthorized("Bearer secre", "secret")).toBe(false);
    expect(await isAuthorized("Bearer secret2", "secret")).toBe(false);
    expect(await isAuthorized("bearer secret", "secret")).toBe(false);
    expect(await isAuthorized("secret", "secret")).toBe(false);
    expect(await isAuthorized(undefined, "secret")).toBe(false);
    expect(await isAuthorized(null, "secret")).toBe(false);
  });

  it("never accepts when the configured token is unset or empty", async () => {
    expect(await isAuthorized("Bearer ", "")).toBe(false);
    expect(await isAuthorized("Bearer", "")).toBe(false);
    expect(await isAuthorized("", "")).toBe(false);
    expect(await isAuthorized("Bearer x", undefined)).toBe(false);
    expect(await isAuthorized(undefined, undefined)).toBe(false);
  });
});

describe("health", () => {
  it("health on empty index reports stale", async () => {
    const r = await SELF.fetch("https://x/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      commit: null,
      last_success_at: null,
      last_run_outcome: null,
      stale: true,
      counts: { pages: 0, sections: 0, endpoints: 0, objects: 0 },
    });
  });

  it("health after indexing reports counts, and goes stale with age", async () => {
    await indexCorpus(env.DB);
    const r = await SELF.fetch("https://x/health");
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof body.last_success_at).toBe("string");
    expect(body.stale).toBe(false);
    expect(body.counts.pages).toBeGreaterThan(150);
    expect(body.counts.sections).toBeGreaterThan(body.counts.pages);
    expect(body.counts.endpoints).toBeGreaterThan(0);
    expect(body.counts.objects).toBeGreaterThan(0);
    expect(Object.keys(body.counts).sort()).toEqual(["endpoints", "objects", "pages", "sections"]);

    const old = new Date(Date.now() - 73 * 3600_000).toISOString();
    await env.DB.prepare("UPDATE refresh_state SET last_success_at = ?1, last_run_outcome = 'failed' WHERE id = 1").bind(old).run();
    const stale = (await (await SELF.fetch("https://x/health")).json()) as any;
    expect(stale).toMatchObject({ stale: true, last_success_at: old, last_run_outcome: "failed" });
    expect(stale.counts.pages).toBeGreaterThan(150);

    const recent = new Date(Date.now() - 71 * 3600_000).toISOString();
    await env.DB.prepare("UPDATE refresh_state SET last_success_at = ?1 WHERE id = 1").bind(recent).run();
    expect(((await (await SELF.fetch("https://x/health")).json()) as any).stale).toBe(false);

    await env.DB.prepare("UPDATE refresh_state SET last_success_at = NULL WHERE id = 1").run();
    expect(((await (await SELF.fetch("https://x/health")).json()) as any).stale).toBe(true);
  }, 120_000);
});

describe("admin refresh", () => {
  it("admin refresh rejects missing or wrong token", async () => {
    expect((await post("/admin/refresh")).status).toBe(401);
    expect((await post("/admin/refresh", { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await post("/admin/refresh", { Authorization: "test-admin-token" })).status).toBe(401);
  });

  it("rejects everything when ADMIN_TOKEN is unset or empty", async () => {
    for (const token of [undefined, ""]) {
      const f = fakeWorkflow();
      const e = { ...f.env, ADMIN_TOKEN: token } as unknown as Env;
      for (const h of [{} as Record<string, string>, { Authorization: "Bearer " }, { Authorization: "Bearer" }, { Authorization: "Bearer undefined" }]) {
        const r = await createApp().request("/admin/refresh", { method: "POST", headers: h }, e);
        expect(r.status).toBe(401);
      }
      expect(f.calls).toEqual([]);
    }
  });

  it("only POST is allowed", async () => {
    const r = await SELF.fetch("https://x/admin/refresh", { headers: AUTH });
    expect(r.status).toBe(404);
  });

  it("creates a manual instance, not forced by default", async () => {
    const f = fakeWorkflow();
    const before = Date.now();
    const r = await createApp().request("/admin/refresh", { method: "POST", headers: AUTH }, f.env);
    expect(r.status).toBe(202);
    const { instanceId } = (await r.json()) as { instanceId: string };
    expect(instanceId).toMatch(/^manual-\d+$/);
    expect(Number(instanceId.slice(7))).toBeGreaterThanOrEqual(before);
    expect(f.calls).toEqual([{ id: instanceId, params: { force: false } }]);
  });

  it("?force=1 forces; other values do not", async () => {
    const f = fakeWorkflow();
    await createApp().request("/admin/refresh?force=1", { method: "POST", headers: AUTH }, f.env);
    await createApp().request("/admin/refresh?force=0", { method: "POST", headers: AUTH }, f.env);
    await createApp().request("/admin/refresh?force=true", { method: "POST", headers: AUTH }, f.env);
    expect(f.calls.map((c) => c.params)).toEqual([{ force: true }, { force: false }, { force: false }]);
  });

  it("unknown routes are 404", async () => {
    expect((await SELF.fetch("https://x/nope")).status).toBe(404);
    expect((await SELF.fetch("https://x/")).status).toBe(404);
  });

  it("admin refresh with token starts a workflow", async () => {
    // No network: resolve-head is mocked as a no-op head, so the run ends right after that step.
    await using wf = await introspectWorkflow(env.REFRESH_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.mockStepResult({ name: "resolve-head" }, noopHead("a".repeat(40)));
    });
    const r = await post("/admin/refresh?force=1", AUTH);
    expect(r.status).toBe(202);
    const { instanceId } = (await r.json()) as { instanceId: string };
    expect(instanceId).toMatch(/^manual-\d+$/);
    const [inst] = await wf.get();
    await inst.waitForStatus("complete");
    expect(await inst.getOutput()).toMatchObject({ outcome: "noop", commitSha: "a".repeat(40) });
  });
});

describe("cron", () => {
  it("instance id is cron-YYYY-MM-DD in UTC", () => {
    expect(cronInstanceId(new Date("2026-10-31T23:59:59.000Z"))).toBe("cron-2026-10-31");
    expect(cronInstanceId(new Date("2026-11-01T00:00:00.000Z"))).toBe("cron-2026-11-01");
  });

  it("scheduled creates the dated instance, not forced", async () => {
    const f = fakeWorkflow();
    const ctrl = { scheduledTime: Date.parse("2026-10-31T04:17:00.000Z"), cron: "17 4 * * *" } as ScheduledController;
    await worker.scheduled!(ctrl, f.env, {} as ExecutionContext);
    expect(f.calls).toEqual([{ id: "cron-2026-10-31", params: { force: false } }]);
  });

  it("ignores an already existing instance, rethrows other errors", async () => {
    const dup = fakeWorkflow(async () => {
      throw new Error("instance.already_exists");
    });
    await expect(startCronRefresh(dup.env, new Date("2026-10-31T04:17:00Z"))).resolves.toBeUndefined();
    const bad = fakeWorkflow(async () => {
      throw new Error("boom");
    });
    await expect(startCronRefresh(bad.env, new Date("2026-10-31T04:17:00Z"))).rejects.toThrow("boom");
  });

  it("a second cron run on the same day with the real binding is ignored", async () => {
    await using wf = await introspectWorkflow(env.REFRESH_WORKFLOW);
    await wf.modifyAll(async (m) => {
      await m.mockStepResult({ name: "resolve-head" }, noopHead("b".repeat(40)));
    });
    const at = new Date("2026-12-24T04:17:00Z");
    await startCronRefresh(env, at);
    await expect(startCronRefresh(env, at)).resolves.toBeUndefined();
    const instances = await wf.get();
    expect(instances).toHaveLength(1);
    await instances[0].waitForStatus("complete");
  });
});
