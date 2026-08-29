import { bundleByToken, saveIntake } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { fail, json, patientView } from "@/lib/api";
import { LIMITS, allow, intakeKey } from "@/lib/ratelimit";
import { conductTurn } from "@/lib/interview/conduct";

type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
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
    return fail("Could not read that message.", 400);
  }
  const b = (body ?? {}) as { answer?: unknown; inputMode?: unknown };
  const answer = typeof b.answer === "string" ? b.answer.slice(0, 4000) : "";
  const inputMode = b.inputMode === "voice" ? "voice" : "text";

  // Everything that reads intake state happens inside the per-intake lock:
  // two concurrent answers (double-tap, flaky-network retry racing its
  // original) must apply one after the other, not both against the same
  // snapshot — the second would silently erase the first.
  return withIntakeLock(found.intake.id, async () => {
    const bundle = bundleByToken(token);
    if (!bundle) return fail("This intake link is no longer valid.", 404);
    if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
      // Duplicate submit or a stale tab. Return current state rather than erroring.
      return json(patientView(bundle));
    }
    if (bundle.intake.status === "not_started") {
      // A message can only follow Start — anything else is a stale tab or a
      // hand-crafted request. Answering it would create an interview with no
      // opening question.
      return fail("This intake hasn't been started yet.", 409);
    }

    const result = await conductTurn({ intake: bundle.intake, answer, inputMode });
    const saved = saveIntake(result.intake);
    return json({ ...patientView({ ...bundle, intake: saved }), finished: result.finished });
  });
}
