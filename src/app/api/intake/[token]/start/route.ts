import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { requireVerifiedPatient } from "@/lib/patient/access";
import { store } from "@/lib/store";
import { startIntake } from "@/lib/interview/conduct";
import { LIMITS, intakeKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "POST /api/intake/[token]/start", async ({ requestId }) => {
    if (!(await enforce(intakeKey(token, "intake"), LIMITS.intakeWrite))) {
      throw new AppError("RATE_LIMITED", "intake write rate exceeded");
    }
    const access = await requireVerifiedPatient(token);
    const s = await store();

    const view = await s.withIntake(access.intakeId, async (intake) => {
      const bundle = { ...(await s.bundleById(access.intakeId))!, intake };
      if (intake.status !== "not_started") {
        // Resuming an interrupted intake is the same call. Never restart their work.
        track("intake_abandoned_resumed", { intake_id: intake.id });
        return { intake: null, result: patientView(bundle) };
      }
      const started = startIntake(intake).intake;
      track("intake_started", { intake_id: started.id });
      return { intake: started, result: patientView({ ...bundle, intake: started }) };
    });

    await audit({
      action: "intake.started",
      actor: access.actor,
      practiceId: access.practiceId,
      resource: "intake",
      resourceId: access.intakeId,
      requestId,
    });
    return jsonOk(view);
  });
}
