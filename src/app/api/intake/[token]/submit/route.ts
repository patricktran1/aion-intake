import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store } from "@/lib/store";
import { LIMITS, intakeKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { generateHpi } from "@/lib/interview/conduct";
import { computeOpenQuestions } from "@/lib/interview/engine";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "POST /api/intake/[token]/submit", async ({ requestId }) => {
    if (!(await enforce(intakeKey(token, "intake"), LIMITS.intakeWrite))) {
      throw new AppError("RATE_LIMITED", "intake write rate exceeded");
    }
    const access = await requireVerifiedPatient(token);
    const s = await store();

    // A double-tap's second request re-reads state after the first commits and
    // takes the idempotent path — one submission, not two.
    const { view, submitted } = await s.withIntake(access.intakeId, async (intake) => {
      const bundle = { ...(await s.bundleById(access.intakeId))!, intake };
      if (intake.status === "ready_for_review" || intake.status === "reviewed") {
        return { intake: null, result: { view: patientView(bundle), submitted: false } };
      }

      const withQuestions = { ...intake, openQuestions: computeOpenQuestions(intake) };
      const { intake: composed } = await generateHpi({ ...bundle, intake: withQuestions });
      const saved = { ...composed, status: "ready_for_review" as const, submittedAt: new Date().toISOString() };

      const startedAt = saved.startedAt ? new Date(saved.startedAt).getTime() : null;
      track("intake_submitted", {
        intake_id: saved.id,
        pathway: saved.pathway,
        question_count: saved.questionCount,
        // The photo count comes from the bundle (the photos table in pilot),
        // not from the document, where pilot photos never live.
        photo_count: bundle.intake.photos.length,
        voice_turns: saved.voiceTurns,
        ai_mode: saved.aiUsage.mode,
        ai_cost_usd: saved.aiUsage.estimatedCostUsd,
        duration_seconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : undefined,
      });
      return { intake: saved, result: { view: patientView({ ...bundle, intake: saved }), submitted: true } };
    });

    if (submitted) {
      await audit({
        action: "intake.submitted",
        actor: access.actor,
        practiceId: access.practiceId,
        resource: "intake",
        resourceId: access.intakeId,
        requestId,
      });
    }
    return jsonOk(view);
  });
}
