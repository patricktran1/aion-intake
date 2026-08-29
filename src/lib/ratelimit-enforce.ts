/**
 * The rate limit a route actually calls.
 *
 * Dispatches on runtime mode: the in-process bucket in demo (correct for one
 * process holding synthetic data), the shared Postgres bucket in pilot (correct
 * for however many instances are running). A route states the key and the
 * budget and does not care which one answers.
 *
 * Keys are chosen per threat, not uniformly:
 *
 *   per intake token   patient writes. A waiting room is one NAT, so keying on
 *                      address would let the first patient throttle the second.
 *   per email address  clinician sign-in. Keying on address would let one
 *                      attacker lock out an entire practice sharing an office
 *                      connection, and is evaded by anyone with a second
 *                      address anyway.
 *   per practice       photo reads. A clinician opening briefs all morning is
 *                      normal; a script pulling every photograph is not.
 */

import { isPilot } from "@/lib/config/runtime";
import { allow, type LimitConfig } from "./ratelimit";
import { allowShared } from "./ratelimit-shared";
import type { Queryable } from "@/lib/db/driver";

export async function enforce(key: string, config: LimitConfig): Promise<boolean> {
  if (!isPilot()) return allow(key, config);

  // Imported lazily so demo mode never loads the database layer.
  const { store } = await import("@/lib/store");
  const s = await store();
  const db = (s as unknown as { driver?: Queryable }).driver;
  // A pilot store without a reachable driver is already a bigger problem than
  // rate limiting; fall back to the in-process bucket rather than failing the
  // request outright.
  if (!db) return allow(key, config);
  return allowShared(db, key, config);
}
