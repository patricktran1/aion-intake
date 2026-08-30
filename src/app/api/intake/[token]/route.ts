import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { resolvePatientAccess, patientBundle } from "@/lib/patient/access";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * The patient's own view of their intake.
 *
 * Resolves the token through the configured store — the demo's memory adapter
 * or the pilot's Postgres — so this is the same code in both modes. It does NOT
 * require the second factor: the patient has to be able to load the page in
 * order to pass it. The response carries `requiresVerification` so the UI shows
 * the prompt or the interview accordingly.
 */
export async function GET(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "GET /api/intake/[token]", async () => {
    const access = await resolvePatientAccess(token);
    const bundle = await patientBundle(access.intakeId);
    track("intake_opened", { intake_id: bundle.intake.id, status: bundle.intake.status });
    return jsonOk({ ...patientView(bundle), requiresVerification: !access.verified });
  });
}
