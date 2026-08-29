import { bundleById, saveIntake } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { fail, json } from "@/lib/api";
import { composeNote } from "@/lib/ai/compose";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ id: string }> };

/**
 * The draft note is assembled deterministically from two clearly separated
 * halves: patient-supplied history and clinician-entered findings. No model
 * writes clinical content here, ever.
 */
export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  if (!bundleById(id)) return fail("Intake not found.", 404);
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
