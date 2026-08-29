import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, type PilotFixture } from "./helpers/pilot";
import { allowShared, sweepRateLimits } from "@/lib/ratelimit-shared";
import { LIMITS } from "@/lib/ratelimit";

/**
 * Shared rate limiting.
 *
 * The property that matters is the one the in-process limiter cannot provide:
 * two instances must share a budget. That is simulated here by calling the
 * limiter concurrently against the same database, which is exactly what two
 * web instances do.
 */

let f: PilotFixture;
beforeAll(async () => {
  f = await createPilotFixture();
}, 60_000);
afterAll(async () => {
  await f.dispose();
});
beforeEach(async () => {
  await f.driver.query("DELETE FROM rate_limits");
});

const SMALL = { burst: 3, refillPerSecond: 1 };

describe("shared token bucket", () => {
  it("allows a burst and then refuses", async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) results.push(await allowShared(f.driver, "k", SMALL));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("refills over time", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 3; i += 1) await allowShared(f.driver, "refill", SMALL, t0);
    expect(await allowShared(f.driver, "refill", SMALL, t0)).toBe(false);

    // Two seconds later, two tokens are back.
    const t1 = new Date(t0.getTime() + 2000);
    expect(await allowShared(f.driver, "refill", SMALL, t1)).toBe(true);
    expect(await allowShared(f.driver, "refill", SMALL, t1)).toBe(true);
    expect(await allowShared(f.driver, "refill", SMALL, t1)).toBe(false);
  });

  it("never refills beyond the burst, however long the gap", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    await allowShared(f.driver, "cap", SMALL, t0);
    const muchLater = new Date(t0.getTime() + 86_400_000);
    const results: boolean[] = [];
    for (let i = 0; i < 4; i += 1) results.push(await allowShared(f.driver, "cap", SMALL, muchLater));
    expect(results).toEqual([true, true, true, false]);
  });

  it("keys are independent, so one patient cannot exhaust another's budget", async () => {
    for (let i = 0; i < 3; i += 1) await allowShared(f.driver, "patient-a", SMALL);
    expect(await allowShared(f.driver, "patient-a", SMALL)).toBe(false);
    expect(await allowShared(f.driver, "patient-b", SMALL)).toBe(true);
  });

  it("two instances competing for one key share a single budget", async () => {
    // This is the property the in-process limiter cannot provide. Concurrent
    // callers against the same row is precisely what two web instances are.
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => allowShared(f.driver, "shared", SMALL)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(3);
  });

  it("a rejected flood does not dig the bucket into a deep hole", async () => {
    // Without clamping, a burst of a hundred would leave a legitimate user
    // waiting a hundred refills rather than one.
    const t0 = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 100; i += 1) await allowShared(f.driver, "flood", SMALL, t0);

    const { rows } = await f.driver.query<{ tokens: number }>(
      "SELECT tokens FROM rate_limits WHERE key = 'flood'",
    );
    expect(Number(rows[0].tokens)).toBeGreaterThanOrEqual(0);

    // One second later exactly one token is available, not a hundred deficits.
    expect(await allowShared(f.driver, "flood", SMALL, new Date(t0.getTime() + 1000))).toBe(true);
  });

  it("allows the request when the database is unreachable", async () => {
    // Failing closed would turn a database blip into a total outage. What this
    // protects is capacity, not authorization — every route does its own.
    const broken = {
      query: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      exec: async () => {},
    };
    expect(await allowShared(broken, "k", SMALL)).toBe(true);
  });

  it("works with the real limits the product ships", async () => {
    // A clinician signing in eight times in a row is fine; the ninth waits.
    const results: boolean[] = [];
    for (let i = 0; i < 9; i += 1) {
      results.push(await allowShared(f.driver, "login:someone@example.test", LIMITS.login));
    }
    expect(results.filter(Boolean)).toHaveLength(LIMITS.login.burst);
  });

  it("sweeping idle buckets is safe — they simply refill", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    await allowShared(f.driver, "old", SMALL, t0);
    expect(await sweepRateLimits(f.driver, new Date(t0.getTime() + 3600_000))).toBe(1);

    const { rows } = await f.driver.query("SELECT * FROM rate_limits WHERE key = 'old'");
    expect(rows).toHaveLength(0);
    // Gone, and the next request starts from a full bucket.
    expect(await allowShared(f.driver, "old", SMALL)).toBe(true);
  });
});
