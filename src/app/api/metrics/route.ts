import { summarize } from "@/lib/analytics";
import { json } from "@/lib/api";
import { handle } from "@/lib/http";
import { isModelEnabled, modelName } from "@/lib/ai/client";
import { isPilot } from "@/lib/config/runtime";
import { requireClinician } from "@/lib/auth/guard";

/**
 * The whole analytics surface: one JSON endpoint. Deliberately not a dashboard.
 * See METRICS.md for what each number is supposed to tell us.
 *
 * The route matrix declares this clinician-only. It was not: the only thing in
 * front of it was a middleware path gate that runs *if* CLINICIAN_ACCESS_CODE
 * is set, and that variable is not part of the pilot configuration at all — it
 * is a demo-era shared password. So in a pilot deployment this was open, and
 * the route-matrix test agreed the matrix held because it exempted this path by
 * name with a comment pointing at that middleware.
 *
 * A test that asserts a guarantee by writing down an exception to it is worse
 * than no test: it produces a green suite and a false matrix. Both the
 * exemption and the gap are gone — there is a real guard here now.
 */
export async function GET(req: Request) {
  return handle(req, "GET /api/metrics", async () => {
    if (isPilot()) await requireClinician();
    return json({
      ...summarize(),
      ai_mode: isModelEnabled() ? "model" : "deterministic",
      model: isModelEnabled() ? modelName() : null,
    });
  });
}
