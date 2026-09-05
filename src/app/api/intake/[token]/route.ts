import { handle, jsonOk } from "@/lib/http";
import { patientView } from "@/lib/api";
import { resolvePatientAccess, patientBundle } from "@/lib/patient/access";
import { track } from "@/lib/analytics";

type Params = { params: Promise<{ token: string }> };

/**
 * The patient's own view of their intake.
 *
 * Resolves the token through the configured store — the demo's memory adapter
 * or the pilot's Postgres — so this is the same code in both modes.
 *
 * Before the second factor is passed this returns `requiresVerification` and
 * NOTHING ELSE. It used to return the whole record alongside that flag, on the
 * reasoning that the patient must be able to load the page in order to pass
 * the factor. But the page only needs to know *that* a factor is required; the
 * record is not needed to render a prompt. Returning it meant one curl against
 * a forwarded link read the entire dermatology intake — name, answers,
 * photographs — with the factor guarding writes alone. The factor is supposed
 * to mean holding the link is not enough, and this is where that was decided.
 */
export async function GET(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "GET /api/intake/[token]", async () => {
    const access = await resolvePatientAccess(token);
    if (!access.verified) return jsonOk({ requiresVerification: true });
    const bundle = await patientBundle(access.intakeId);
    track("intake_opened", { intake_id: bundle.intake.id, status: bundle.intake.status });
    return jsonOk({ ...patientView(bundle, { token }), requiresVerification: false });
  });
}
