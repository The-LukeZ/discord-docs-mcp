import { DurableObject } from "cloudflare:workers";

export interface Caps {
  perMinute: number;
  perDay: number;
}

export type ConsumeResult = { allowed: true } | { allowed: false; window: "minute" | "day"; retryAfterSeconds: number };

interface Counter {
  /** window id: `floor(now / 60000)` for the minute counter, the UTC date (YYYY-MM-DD) for the day counter */
  w: number | string;
  c: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The single global usage limiter. State is two counters and their window ids, nothing else: no IPs, no client
 * identifiers. Fixed windows: the minute is `floor(now / 60000)`, the day is the UTC date.
 *
 * `consume` is synchronous inside (storage.kv is synchronous), so the read-check-write sequence has no await and
 * cannot interleave with another call: it is atomic for the Durable Object.
 */
export class GlobalLimiter extends DurableObject<Env> {
  async consume(nowMs: number, caps: Caps): Promise<ConsumeResult> {
    const kv = this.ctx.storage.kv;
    const minute = Math.floor(nowMs / MINUTE_MS);
    const day = new Date(nowMs).toISOString().slice(0, 10);

    const m = kv.get<Counter>("minute");
    const d = kv.get<Counter>("day");
    const minuteCount = m && m.w === minute ? m.c : 0;
    const dayCount = d && d.w === day ? d.c : 0;

    // The day window is checked first: when both are exhausted its longer wait is the useful answer.
    if (dayCount >= caps.perDay) {
      const nextMidnight = Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS;
      return { allowed: false, window: "day", retryAfterSeconds: Math.ceil((nextMidnight - nowMs) / 1000) };
    }
    if (minuteCount >= caps.perMinute) {
      return { allowed: false, window: "minute", retryAfterSeconds: Math.ceil(((minute + 1) * MINUTE_MS - nowMs) / 1000) };
    }

    // Denied calls above return without writing, so a flood does not keep touching storage.
    kv.put("minute", { w: minute, c: minuteCount + 1 } satisfies Counter);
    kv.put("day", { w: day, c: dayCount + 1 } satisfies Counter);
    return { allowed: true };
  }

  jurisdiction(): string | undefined {
    return this.ctx.id.jurisdiction;
  }
}

/**
 * The one limiter instance, always in the EU jurisdiction. `name` is only overridden by tests.
 *
 * Local workerd (`wrangler dev`, vitest) does not implement jurisdictions and throws a specific error from
 * `jurisdiction()`. Only that error falls back to the plain namespace, so local runs work; on Cloudflare the
 * jurisdiction call succeeds and any other failure propagates (the guard then fails closed).
 */
export function limiterStub(env: Env, name = "global") {
  try {
    return env.LIMITER.jurisdiction("eu").getByName(name);
  } catch (e) {
    if (e instanceof Error && /not implemented in workerd/i.test(e.message)) return env.LIMITER.getByName(name);
    throw e;
  }
}
