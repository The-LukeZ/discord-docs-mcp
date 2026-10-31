import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { limiterStub } from "../../src/limit/limiter";

const caps = { perMinute: 3, perDay: 5 };
// limiterStub is the production accessor (jurisdiction "eu", name "global" by default).
const stub = (name: string) => limiterStub(env, name);

// Local workerd does not implement jurisdictions, so the real jurisdiction can only be checked on Cloudflare.
let jurisdictionsSupported = true;
try {
  env.LIMITER.jurisdiction("eu");
} catch {
  jurisdictionsSupported = false;
}

describe("GlobalLimiter", () => {
  it("trips the minute cap and resets next minute", async () => {
    const s = stub("t1");
    const t = Date.UTC(2026, 9, 31, 12, 0, 1);
    for (let i = 0; i < 3; i++) expect((await s.consume(t, caps)).allowed).toBe(true);
    expect(await s.consume(t, caps)).toEqual({ allowed: false, window: "minute", retryAfterSeconds: 59 });
    expect((await s.consume(t + 60_000, caps)).allowed).toBe(true);
  });

  it("does not count denied calls", async () => {
    const s = stub("t-denied");
    const t = Date.UTC(2026, 9, 31, 12, 0, 1);
    for (let i = 0; i < 3; i++) await s.consume(t, caps);
    for (let i = 0; i < 10; i++) expect((await s.consume(t, caps)).allowed).toBe(false);
    // Only 3 of the 5 daily calls were used: two more minutes fit, a third call in a later minute is the 6th.
    for (let m = 1; m <= 2; m++) expect((await s.consume(t + m * 60_000, caps)).allowed).toBe(true);
    expect((await s.consume(t + 3 * 60_000, caps)).allowed).toBe(false);
  });

  it("trips the day cap and resets at UTC midnight", async () => {
    const s = stub("t2");
    const t = Date.UTC(2026, 9, 31, 23, 0, 0);
    // 5 calls, each in its own minute, so only the day window fills.
    for (let i = 0; i < 5; i++) expect((await s.consume(t + i * 60_000, caps)).allowed).toBe(true);
    const sixth = t + 5 * 60_000; // 23:05:00
    expect(await s.consume(sixth, caps)).toEqual({ allowed: false, window: "day", retryAfterSeconds: 55 * 60 });
    expect((await s.consume(Date.UTC(2026, 10, 1, 0, 0, 0), caps)).allowed).toBe(true);
  });

  it("always asks for the eu jurisdiction and the global instance", async () => {
    const calls: unknown[][] = [];
    const fake = {
      LIMITER: {
        jurisdiction: (j: string) => (calls.push(["jurisdiction", j]), { getByName: (n: string) => (calls.push(["getByName", n]), "stub") }),
      },
    } as unknown as Env;
    expect(limiterStub(fake)).toBe("stub");
    expect(calls).toEqual([["jurisdiction", "eu"], ["getByName", "global"]]);
  });

  it.skipIf(!jurisdictionsSupported)("runs in the eu jurisdiction", async () => {
    expect(await limiterStub(env).jurisdiction()).toBe("eu");
  });

  it("falls back to the plain namespace only where workerd lacks jurisdictions", async () => {
    const plain = { LIMITER: { jurisdiction: () => { throw new Error("Jurisdiction restrictions are not implemented in workerd."); }, getByName: () => "plain" } } as unknown as Env;
    expect(limiterStub(plain)).toBe("plain");
    const broken = { LIMITER: { jurisdiction: () => { throw new Error("something else"); } } } as unknown as Env;
    expect(() => limiterStub(broken)).toThrow("something else");
  });

  it("concurrent calls never exceed the cap", async () => {
    const s = stub("t-concurrent");
    const t = Date.UTC(2026, 9, 31, 12, 0, 1);
    const results = await Promise.all(Array.from({ length: 10 }, () => s.consume(t, caps)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });
});
