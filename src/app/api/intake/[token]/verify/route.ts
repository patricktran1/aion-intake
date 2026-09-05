import { handle, jsonOk } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { store } from "@/lib/store";
import { MAX_VERIFICATION_ATTEMPTS } from "@/lib/patient/token";
import { secondFactorFor, type SecondFactorKind } from "@/lib/patient/second-factor";
import { pilotConfig } from "@/lib/config/runtime";
import { LIMITS, intakeKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { audit } from "@/lib/audit";
import { isPilot } from "@/lib/config/runtime";

type Params = { params: Promise<{ token: string }> };

/**
 * The patient's second factor.
 *
 * Holding the link is not enough in pilot mode: a forwarded SMS on a shared
 * phone must not open someone's dermatology history. Which factor is asked for
 * is a strategy — see patient/second-factor.ts for the three and their
 * tradeoffs — and the route knows only that there is one. The default, and what
 * the synthetic pilot runs, is date of birth.
 *
 * Wrong answers are counted in the database, not in memory, so the limit
 * survives a restart and cannot be reset by moving to another instance. After
 * MAX_VERIFICATION_ATTEMPTS the token is dead and the practice must reissue.
 * That durable budget is what makes a short code viable at all: five guesses,
 * not unbounded ones.
 */
/**
 * What to ask. One field, one label, one line of hint — whichever factor is in
 * force. The screen renders this rather than knowing about factors, which is
 * what keeps a third strategy from becoming a third thing on the patient's
 * screen. Returns nothing about the expected answer.
 */
export async function GET(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "GET /api/intake/[token]/verify", async () => {
    const s = await store();
    const resolved = await s.resolveToken(token);
    // A challenge for an unknown token would confirm which links exist.
    if (!resolved.ok) throw new AppError("NOT_FOUND", "no such intake token");
    if (!isPilot()) return jsonOk({ required: false });

    const kind = (resolved.access.secondFactorKind || "dob") as SecondFactorKind;
    return jsonOk({
      required: !resolved.access.verifiedAt,
      challenge: secondFactorFor(kind, pilotConfig().tokenPepper).challenge(),
      attemptsRemaining: Math.max(0, MAX_VERIFICATION_ATTEMPTS - resolved.access.failedVerifications),
    });
  });
}

export async function POST(req: Request, { params }: Params) {
  const { token } = await params;
  return handle(req, "POST /api/intake/[token]/verify", async ({ requestId }) => {
    if (!(await enforce(intakeKey(token, "verify"), LIMITS.patientVerify))) {
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
    // One field on the wire whatever the configured factor is. `dateOfBirth`
    // stays accepted as the field name so links and clients issued before the
    // factor became pluggable keep working.
    const asRecord = (body ?? {}) as { answer?: unknown; dateOfBirth?: unknown };
    const raw = typeof asRecord.answer === "string" ? asRecord.answer : asRecord.dateOfBirth;
    const supplied = typeof raw === "string" ? raw.slice(0, 64) : "";

    const bundle = await s.bundleById(resolved.access.intakeId);
    if (!bundle) throw new AppError("NOT_FOUND", "intake vanished between resolve and read");

    // The factor recorded on the token, not the one currently configured: a
    // practice changing policy must not lock out links already in patients'
    // hands. An unrecognised stored value falls back to the default rather than
    // throwing, because a 500 here reads to the patient as "the link is broken".
    const kind = (resolved.access.secondFactorKind || "dob") as SecondFactorKind;
    const factor = secondFactorFor(kind, pilotConfig().tokenPepper);

    const passed = factor.verify(supplied, {
      intakeId: resolved.access.intakeId,
      practiceId: resolved.access.practiceId,
      patientDateOfBirth: bundle.patient.dateOfBirth,
      storedHash: resolved.access.secondFactorHash,
      storedExpiresAt: resolved.access.secondFactorExpiresAt,
    });

    if (!passed) {
      const failures = await s.recordVerificationFailure(resolved.access.intakeId);
      await audit({
        action: "intake.verification_failed",
        actor: { kind: "patient", intakeId: resolved.access.intakeId },
        practiceId: resolved.access.practiceId,
        resource: "intake",
        resourceId: resolved.access.intakeId,
        requestId,
        meta: { attempt: failures, factor: kind },
      });
      if (failures >= MAX_VERIFICATION_ATTEMPTS) throw new AppError("INTAKE_REVOKED", "token locked");
      throw new AppError("VERIFICATION_FAILED", "second factor did not match");
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
