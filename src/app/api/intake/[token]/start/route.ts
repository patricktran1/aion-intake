import { bundleByToken, saveIntake } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { fail, json, patientView } from "@/lib/api";
import { startIntake } from "@/lib/interview/conduct";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { token } = await params;
  const found = bundleByToken(token);
  if (!found) return fail("This intake link is no longer valid.", 404);
  return withIntakeLock(found.intake.id, async () => {
    const bundle = bundleByToken(token);
    if (!bundle) return fail("This intake link is no longer valid.", 404);
    if (bundle.intake.status !== "not_started") {
      // Resuming an interrupted intake is the same call. Never restart their work.
      track("intake_abandoned_resumed", { intake_id: bundle.intake.id });
      return json(patientView(bundle));
    }
    const result = startIntake(bundle.intake);
    const saved = saveIntake(result.intake);
    track("intake_started", { intake_id: saved.id });
    return json(patientView({ ...bundle, intake: saved }));
  });
}
