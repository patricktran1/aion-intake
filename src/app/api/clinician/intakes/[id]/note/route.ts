import { store } from "@/lib/store";
import { clinicianWriteScope } from "@/lib/auth/scope";
import { fail, json } from "@/lib/api";
import { handle } from "@/lib/http";
import { composeNote } from "@/lib/ai/compose";
import { audit } from "@/lib/audit";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ id: string }> };

/**
 * The draft note is assembled deterministically from two clearly separated
 * halves: patient-supplied history and clinician-entered findings. No model
 * writes clinical content here, ever. Persisted through the store so it is
 * durable in pilot mode.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return handle(req, "POST /api/clinician/intakes/[id]/note", async ({ requestId }) => {
    const scope = await clinicianWriteScope(req);
    const s = await store();
    // Existence-and-tenant check first: a note for an unknown or other-practice
    // intake is a 404 (never a 500), and never leaks another practice's history.
    const found = scope.practiceId
      ? await s.bundleForClinician(id, scope.practiceId)
      : await s.bundleById(id);
    if (!found) return fail("Intake not found.", 404);

    const note = await s.withIntake(id, async (intake) => {
      const bundle = await s.bundleById(id);
      if (!bundle) return { intake: null, result: "" };
      const composed = composeNote({ ...bundle, intake });
      track("clinician_note_generated", {
        intake_id: intake.id,
        has_exam: intake.review.exam.trim().length > 0,
        has_assessment: intake.review.assessment.trim().length > 0,
        has_plan: intake.review.plan.trim().length > 0,
      });
      return { intake: { ...intake, note: composed }, result: composed };
    });

    await audit({
      action: "note.generated",
      actor: scope.actor,
      practiceId: scope.practiceId,
      resource: "intake",
      resourceId: id,
      requestId,
    });
    return json({ note });
  });
}
