import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store } from "@/lib/store";
import { LIMITS, intakeKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { classifyCertainty, tidy } from "@/lib/interview/engine";
import { AppError } from "@/lib/errors";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * The patient's correction is authoritative. An edited fact becomes their
 * verbatim too — a physician reading the brief must never see a summary the
 * patient already disagreed with.
 */
export async function PATCH(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "PATCH /api/intake/[token]/facts", async () => {
    if (!(await enforce(intakeKey(token, "intake"), LIMITS.intakeWrite))) {
      throw new AppError("RATE_LIMITED", "intake write rate exceeded");
    }
    const access = await requireVerifiedPatient(token);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new AppError("BAD_REQUEST", "unparseable edit body");
    }
    const b = (body ?? {}) as { slot?: unknown; value?: unknown };
    const slot = typeof b.slot === "string" ? b.slot : "";
    const value = typeof b.value === "string" ? b.value.trim().slice(0, 1000) : "";
    if (!slot) throw new AppError("BAD_REQUEST", "missing slot");

    const s = await store();
    const view = await s.withIntake(access.intakeId, async (intake) => {
      const bundle = { ...(await s.bundleById(access.intakeId))!, intake };
      // Patient-supplied facts freeze at submission — a link holder must not
      // rewrite history underneath a clinician's review.
      if (intake.status === "ready_for_review" || intake.status === "reviewed") {
        throw new AppError("INTAKE_COMPLETE", "facts edited after submission");
      }
      const facts = intake.facts.filter((f) => f.slot !== slot);
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
      const saved = { ...intake, facts };
      track("intake_review_edited", { intake_id: saved.id, slot, cleared: value.length === 0 });
      return { intake: saved, result: patientView({ ...bundle, intake: saved }) };
    });
    return jsonOk(view);
  });
}
