import { bundleByToken, saveIntake } from "@/lib/store";
import { fail, json, patientView } from "@/lib/api";
import { conductTurn } from "@/lib/interview/conduct";

type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  const bundle = bundleByToken(token);
  if (!bundle) return fail("This intake link is no longer valid.", 404);
  if (bundle.intake.status === "ready_for_review" || bundle.intake.status === "reviewed") {
    // Duplicate submit or a stale tab. Return current state rather than erroring.
    return json(patientView(bundle));
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

  const result = await conductTurn({ intake: bundle.intake, answer, inputMode });
  const saved = saveIntake(result.intake);
  return json({ ...patientView({ ...bundle, intake: saved }), finished: result.finished });
}
