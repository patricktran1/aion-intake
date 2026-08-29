import { bundleByToken, saveIntake } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { fail, json, patientView } from "@/lib/api";
import { LIMITS, allow, intakeKey } from "@/lib/ratelimit";
import { generateHpi } from "@/lib/interview/conduct";
import { computeOpenQuestions } from "@/lib/interview/engine";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  const found = bundleByToken(token);
  if (!found) return fail("This intake link is no longer valid.", 404);
  if (!allow(intakeKey(token, "intake"), LIMITS.intakeWrite)) {
    return fail("You're going a little fast — give it a moment and try again.", 429);
  }

  // Under the lock, a double-tap's second request re-reads state after the
  // first has committed and takes the idempotent path below.
  return withIntakeLock(found.intake.id, async () => {
    const bundle = bundleByToken(token);
    if (!bundle) return fail("This intake link is no longer valid.", 404);

    // Idempotent: a double-tap on a slow phone must not create a second intake.
    if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
      return json(patientView(bundle));
    }

    const withQuestions = {
      ...bundle.intake,
      openQuestions: computeOpenQuestions(bundle.intake),
    };
    const { intake } = await generateHpi({ ...bundle, intake: withQuestions });

    const submittedAt = new Date().toISOString();
    const saved = saveIntake({ ...intake, status: "ready_for_review", submittedAt });

    const startedAt = saved.startedAt ? new Date(saved.startedAt).getTime() : null;
    track("intake_submitted", {
      intake_id: saved.id,
      pathway: saved.pathway,
      question_count: saved.questionCount,
      photo_count: saved.photos.length,
      voice_turns: saved.voiceTurns,
      ai_mode: saved.aiUsage.mode,
      ai_cost_usd: saved.aiUsage.estimatedCostUsd,
      duration_seconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : undefined,
    });

    return json(patientView({ ...bundle, intake: saved }));
  });
}
