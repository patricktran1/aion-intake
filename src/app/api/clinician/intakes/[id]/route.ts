import { store } from "@/lib/store";
import { clinicianWriteScope } from "@/lib/auth/scope";
import { fail, json } from "@/lib/api";
import { handle, readJson } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { MAX_REVIEW_FIELD, clinicianReviewSchema } from "@/lib/domain/types";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ id: string }> };

/**
 * Clinician edits. The HPI and the review fields are the only writable surface —
 * patient-supplied facts are never overwritten from this side, so provenance in
 * the brief stays true.
 *
 * The whole read-modify-write goes through store.withIntake, so it is durable
 * in pilot mode and serialised against a second clinician (or a second tab)
 * editing the same brief — a row lock in pilot, a promise chain in demo.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  return handle(req, "PATCH /api/clinician/intakes/[id]", async ({ requestId }) => {
    const scope = await clinicianWriteScope(req);
    const s = await store();
    // Existence-and-tenant check before any write: scoped to the practice when
    // we have one (pilot), unscoped in demo's single synthetic practice. Either
    // way an unknown or other-practice intake is a 404, never a 500 from the
    // write path.
    const found = scope.practiceId
      ? await s.bundleForClinician(id, scope.practiceId)
      : await s.bundleById(id);
    if (!found) return fail("Intake not found.", 404);

    const body = await readJson(req);
    const b = (body ?? {}) as { hpi?: unknown; review?: unknown };
    // A body carrying neither writable field used to return 200, change
    // nothing, and append an audit event claiming the HPI had been edited. An
    // audit trail that records edits which never happened is worse than none,
    // and a client sending the wrong field name got no signal that its write
    // had gone nowhere.
    const writesHpi = typeof b.hpi === "string";
    const writesReview = Boolean(b.review) && typeof b.review === "object";
    if (!writesHpi && !writesReview) {
      throw new AppError("BAD_REQUEST", "update must carry hpi or review");
    }

    const result = await s.withIntake(id, async (current) => {
      let intake = current;
      if (typeof b.hpi === "string") {
        const hpi = b.hpi.slice(0, 20000);
        const edited = hpi.trim() !== intake.hpiGenerated.trim();
        if (edited && !intake.hpiEditedByClinician) track("clinician_hpi_edited", { intake_id: intake.id });
        intake = { ...intake, hpi, hpiEditedByClinician: edited };
      }
      if (b.review && typeof b.review === "object") {
        // Truncate before validating, so a physician who pastes a very long note
        // gets it saved and trimmed rather than rejected mid-encounter.
        const incoming = Object.fromEntries(
          Object.entries(b.review as Record<string, unknown>).map(([k, v]) => [
            k,
            typeof v === "string" ? v.slice(0, MAX_REVIEW_FIELD) : v,
          ]),
        );
        const parsed = clinicianReviewSchema.safeParse({ ...intake.review, ...incoming });
        if (!parsed.success) throw new AppError("BAD_REQUEST", "invalid review fields");
        // "reviewed" is a state a submitted intake moves into — never a jump
        // from not_started/in_progress.
        if (intake.status !== "ready_for_review" && intake.status !== "reviewed") {
          throw new AppError("INTAKE_NOT_STARTED", "review before submission");
        }
        intake = {
          ...intake,
          review: { ...parsed.data, updatedAt: new Date().toISOString() },
          status: "reviewed",
        };
      }
      return {
        intake,
        result: { ok: true, hpi: intake.hpi, review: intake.review, status: intake.status },
      };
    });

    await audit({
      action: b.review ? "review.updated" : "hpi.edited",
      actor: scope.actor,
      practiceId: scope.practiceId,
      resource: "intake",
      resourceId: id,
      requestId,
    });
    return json(result);
  });
}
