import { bundleById, saveIntake, store } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { clinicianWriteScope } from "@/lib/auth/scope";
import { fail, json } from "@/lib/api";
import { composeNote } from "@/lib/ai/compose";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ id: string }> };

/**
 * The draft note is assembled deterministically from two clearly separated
 * halves: patient-supplied history and clinician-entered findings. No model
 * writes clinical content here, ever.
 */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  // Tenant check first: generating a note for another practice's patient would
  // both leak their history and write to their record.
  const scope = await clinicianWriteScope(req);
  if (scope.practiceId) {
    const s = await store();
    if (!(await s.bundleForClinician(id, scope.practiceId))) return fail("Intake not found.", 404);
  } else if (!bundleById(id)) {
    return fail("Intake not found.", 404);
  }
  return withIntakeLock(id, async () => {
    const bundle = bundleById(id);
    if (!bundle) return fail("Intake not found.", 404);
    const note = composeNote(bundle);
    const saved = saveIntake({ ...bundle.intake, note });
    track("clinician_note_generated", {
      intake_id: saved.id,
      has_exam: saved.review.exam.trim().length > 0,
      has_assessment: saved.review.assessment.trim().length > 0,
      has_plan: saved.review.plan.trim().length > 0,
    });
    return json({ note });
  });
}
