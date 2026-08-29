/**
 * Shared rate limiting for pilot mode.
 *
 * The in-process limiter is correct for exactly one instance. With two, each
 * keeps its own counters: an attacker gets double the budget, and a patient
 * can be throttled by whichever instance happens to hold their history. Since
 * a pilot already has Postgres, the shared counter goes there rather than
 * adding Redis for a few hundred writes an hour.
 *
 * The whole limiter is one statement. `INSERT … ON CONFLICT DO UPDATE` makes
 * the read-modify-write atomic at the row, so two instances competing for the
 * same key serialise in the database rather than both seeing a full bucket.
 * Tokens are refilled arithmetically from the stored timestamp, so there is no
 * background job.
 *
 * Failure policy: if the database is unreachable the limiter allows the
 * request. That is deliberate. A limiter that fails closed converts a database
 * blip into a total outage, and the thing being protected here is capacity,
 * not authorization — every route behind it does its own authorization.
 */

import type { Queryable } from "@/lib/db/driver";
import type { LimitConfig } from "./ratelimit";
import { log } from "@/lib/log";

/**
 * @returns true when the request may proceed.
 */
export async function allowShared(
  db: Queryable,
  key: string,
  config: LimitConfig,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const { rows } = await db.query<{ tokens: number }>(
      `INSERT INTO rate_limits (key, tokens, updated_at)
       VALUES ($1, $2 - 1, $4)
       ON CONFLICT (key) DO UPDATE SET
         tokens = LEAST(
                    $2::double precision,
                    rate_limits.tokens
                      + GREATEST(0, EXTRACT(EPOCH FROM ($4::timestamptz - rate_limits.updated_at)) * $3)
                  ) - 1,
         updated_at = $4
       RETURNING tokens`,
      [key, config.burst, config.refillPerSecond, now.toISOString()],
    );
    const remaining = Number(rows[0]?.tokens ?? 0);
    if (remaining >= 0) return true;

    // Over budget. Put the token back so a rejected request does not dig the
    // bucket deeper and deeper the harder someone hammers it — otherwise a
    // burst of a thousand leaves a legitimate user waiting for a thousand
    // refills rather than one.
    await db.query("UPDATE rate_limits SET tokens = 0 WHERE key = $1 AND tokens < 0", [key]);
    return false;
  } catch (err) {
    log.warn("shared rate limit unavailable, allowing request", {
      reason: err instanceof Error ? err.name : "unknown",
    });
    return true;
  }
}

/**
 * Drops buckets nobody has touched in a while. Optional housekeeping: an
 * evicted bucket simply refills to full, so forgetting to run this costs disk
 * rather than correctness.
 */
export async function sweepRateLimits(db: Queryable, olderThan: Date): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM rate_limits WHERE updated_at < $1", [
    olderThan.toISOString(),
  ]);
  return rowCount;
}
