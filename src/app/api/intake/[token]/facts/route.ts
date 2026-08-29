import { bundleByToken, saveIntake } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { fail, json, patientView } from "@/lib/api";
import { LIMITS, allow, intakeKey } from "@/lib/ratelimit";
import { classifyCertainty, tidy } from "@/lib/interview/engine";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * The patient's correction is authoritative. An edited fact becomes their
 * verbatim too — a physician reading the brief must never see a summary the
 * patient already disagreed with.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { token } = await params;
  const found = bundleByToken(token);
  if (!found) return fail("This intake link is no longer valid.", 404);
  if (!allow(intakeKey(token, "intake"), LIMITS.intakeWrite)) {
    return fail("You're going a little fast — give it a moment and try again.", 429);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Could not read that edit.", 400);
  }
  const b = (body ?? {}) as { slot?: unknown; value?: unknown };
  const slot = typeof b.slot === "string" ? b.slot : "";
  const value = typeof b.value === "string" ? b.value.trim().slice(0, 1000) : "";
  if (!slot) return fail("Missing field.", 400);

  return withIntakeLock(found.intake.id, async () => {
    const bundle = bundleByToken(token);
    if (!bundle) return fail("This intake link is no longer valid.", 404);
    // Patient-supplied facts freeze at submission. After that, the brief is what
    // the clinician reviews; a link holder must not be able to rewrite history
    // underneath a review.
    if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
      return fail("This intake has been submitted and can no longer be edited.", 409);
    }

    const facts = bundle.intake.facts.filter((f) => f.slot !== slot);
    if (value) {
      facts.push({
        slot,
        value: tidy(value),
        verbatim: value,
        certainty: classifyCertainty(value),
        source: "patient",
        at: new Date().toISOString(),
      });
    }
    const saved = saveIntake({ ...bundle.intake, facts });
    track("intake_review_edited", { intake_id: saved.id, slot, cleared: value.length === 0 });
    return json(patientView({ ...bundle, intake: saved }));
  });
}
