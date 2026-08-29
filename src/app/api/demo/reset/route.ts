import { resetDb } from "@/lib/store";
import { fail, json } from "@/lib/api";
import { resetAnalytics, track } from "@/lib/analytics";
import { LIMITS, allow, clientKey, isSameOrigin } from "@/lib/ratelimit";
import { isPilot } from "@/lib/config/runtime";

/**
 * Restores the synthetic demo to a known state.
 *
 * Guarded, lightly: nothing here is sensitive, but a stranger resetting the
 * demo in the middle of a conference conversation is a bad afternoon.
 */
export async function POST(req: Request) {
  // In pilot mode this endpoint would delete real records. Config validation
  // already refuses to start a pilot with AION_ALLOW_DEMO_RESET set, and this
  // is the second lock: two independent mistakes are needed to reach the reset.
  if (isPilot()) return fail("Not found.", 404);
  if (!isSameOrigin(req)) return fail("Not allowed from another origin.", 403);
  if (!allow(clientKey(req, "reset"), LIMITS.demoReset)) {
    return fail("The demo was reset a moment ago. Try again shortly.", 429);
  }
  if (!allow("reset:global", LIMITS.demoResetGlobal)) {
    return fail("The demo was reset a moment ago. Try again shortly.", 429);
  }
  resetAnalytics();
  const d = resetDb();
  track("demo_reset", { intakes: d.intakes.size });
  return json({ ok: true, intakes: d.intakes.size, seededAt: d.seededAt });
}
