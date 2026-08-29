import { bundleById, saveIntake } from "@/lib/store";
import { fail, json } from "@/lib/api";
import { clinicianReviewSchema } from "@/lib/domain/types";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ id: string }> };

/**
 * Clinician edits. The HPI and the review fields are the only writable surface —
 * patient-supplied facts are never overwritten from this side, so provenance in
 * the brief stays true.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const bundle = bundleById(id);
  if (!bundle) return fail("Intake not found.", 404);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Could not read that update.", 400);
  }
  const b = (body ?? {}) as { hpi?: unknown; review?: unknown };

  let intake = bundle.intake;
  if (typeof b.hpi === "string") {
    const hpi = b.hpi.slice(0, 20000);
    const edited = hpi.trim() !== intake.hpiGenerated.trim();
    if (edited && !intake.hpiEditedByClinician) {
      track("clinician_hpi_edited", { intake_id: intake.id });
    }
    intake = { ...intake, hpi, hpiEditedByClinician: edited };
  }
  if (b.review && typeof b.review === "object") {
    const parsed = clinicianReviewSchema.safeParse({ ...intake.review, ...b.review });
    if (!parsed.success) return fail("Invalid review fields.", 400);
    intake = {
      ...intake,
      review: { ...parsed.data, updatedAt: new Date().toISOString() },
      status: "reviewed",
    };
  }
  const saved = saveIntake(intake);
  return json({ ok: true, hpi: saved.hpi, review: saved.review, status: saved.status });
}
