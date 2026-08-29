import { handle, jsonOk } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { store } from "@/lib/store";
import { dobMatches, MAX_VERIFICATION_ATTEMPTS } from "@/lib/patient/token";
import { LIMITS, allow, intakeKey } from "@/lib/ratelimit";
import { audit } from "@/lib/audit";
import { isPilot } from "@/lib/config/runtime";

type Params = { params: Promise<{ token: string }> };

/**
 * The patient's second factor.
 *
 * Holding the link is not enough in pilot mode: a forwarded SMS on a shared
 * phone must not open someone's dermatology history. The factor is the date of
 * birth the practice already holds and the patient always knows. It is a
 * possession check, not identity proofing, and is not claimed to be more.
 *
 * Wrong answers are counted in the database, not in memory, so the limit
 * survives a restart and cannot be reset by moving to another instance. After
 * MAX_VERIFICATION_ATTEMPTS the token is dead and the practice must reissue.
 */
export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "POST /api/intake/[token]/verify", async ({ requestId }) => {
    if (!allow(intakeKey(token, "verify"), LIMITS.patientVerify)) {
      throw new AppError("RATE_LIMITED", "too many verification attempts");
    }

    const s = await store();
    const resolved = await s.resolveToken(token);
    if (!resolved.ok) {
      if (resolved.reason === "expired") throw new AppError("INTAKE_EXPIRED", "token past expiry");
      if (resolved.reason === "revoked") throw new AppError("INTAKE_REVOKED", "token revoked");
      if (resolved.reason === "locked") throw new AppError("INTAKE_REVOKED", "token locked");
      throw new AppError("NOT_FOUND", "no such intake token");
    }

    // Demo links carry no second factor by design; verification is a no-op so
    // a conference demo is not gated on a synthetic patient's date of birth.
    if (!isPilot()) return jsonOk({ verified: true });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new AppError("BAD_REQUEST", "unparseable verification body");
    }
    const supplied = typeof (body as { dateOfBirth?: unknown })?.dateOfBirth === "string"
      ? ((body as { dateOfBirth: string }).dateOfBirth).slice(0, 40)
      : "";

    const bundle = await s.bundleById(resolved.access.intakeId);
    if (!bundle) throw new AppError("NOT_FOUND", "intake vanished between resolve and read");

    if (!supplied || !dobMatches(supplied, bundle.patient.dateOfBirth)) {
      const failures = await s.recordVerificationFailure(resolved.access.intakeId);
      await audit({
        action: "intake.verification_failed",
        actor: { kind: "patient", intakeId: resolved.access.intakeId },
        practiceId: resolved.access.practiceId,
        resource: "intake",
        resourceId: resolved.access.intakeId,
        requestId,
        meta: { attempt: failures },
      });
      if (failures >= MAX_VERIFICATION_ATTEMPTS) throw new AppError("INTAKE_REVOKED", "token locked");
      throw new AppError("VERIFICATION_FAILED", "date of birth did not match");
    }

    await s.markVerified(resolved.access.intakeId);
    await audit({
      action: "intake.verified",
      actor: { kind: "patient", intakeId: resolved.access.intakeId },
      practiceId: resolved.access.practiceId,
      resource: "intake",
      resourceId: resolved.access.intakeId,
      requestId,
    });
    return jsonOk({ verified: true });
  });
}
