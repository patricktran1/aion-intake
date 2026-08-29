import { resetDb } from "@/lib/store";
import { json } from "@/lib/api";
import { resetAnalytics, track } from "@/lib/analytics";

/** Restores the synthetic demo to a known state. Safe to call at any time. */
export async function POST() {
  resetAnalytics();
  const d = resetDb();
  track("demo_reset", { intakes: d.intakes.size });
  return json({ ok: true, intakes: d.intakes.size, seededAt: d.seededAt });
}
