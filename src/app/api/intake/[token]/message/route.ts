import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store } from "@/lib/store";
import { LIMITS, intakeKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { conductTurn } from "@/lib/interview/conduct";
import { AppError } from "@/lib/errors";

type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "POST /api/intake/[token]/message", async () => {
    if (!(await enforce(intakeKey(token, "intake"), LIMITS.intakeWrite))) {
      throw new AppError("RATE_LIMITED", "intake write rate exceeded");
    }
    const access = await requireVerifiedPatient(token);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new AppError("BAD_REQUEST", "unparseable message body");
    }
    const b = (body ?? {}) as { answer?: unknown; inputMode?: unknown };
    const answer = typeof b.answer === "string" ? b.answer.slice(0, 4000) : "";
    const inputMode = b.inputMode === "voice" ? "voice" : "text";

    const s = await store();
    // The whole read-modify-write is inside withIntake: two concurrent answers
    // (double tap, a flaky-network retry racing its original) apply one after
    // the other, never both against the same snapshot. In pilot that is a row
    // lock; in demo a promise chain — same guarantee either way.
    const view = await s.withIntake(access.intakeId, async (intake) => {
      const bundle = { ...(await s.bundleById(access.intakeId))!, intake };
      if (intake.status === "ready_for_review" || intake.status === "reviewed") {
        // Duplicate submit or a stale tab. Return current state, do not error.
        return { intake: null, result: patientView(bundle) };
      }
      if (intake.status === "not_started") {
        // A message can only follow Start. Answering it would create an
        // interview with no opening question.
        throw new AppError("INTAKE_NOT_STARTED", "message before start");
      }
      const turn = await conductTurn({ intake, answer, inputMode });
      return {
        intake: turn.intake,
        result: { ...patientView({ ...bundle, intake: turn.intake }), finished: turn.finished },
      };
    });
    return jsonOk(view);
  });
}
