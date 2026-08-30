/**
 * Patient access, resolved through the configured store.
 *
 * This is the seam the patient routes were missing. They resolved tokens and
 * saved intakes through the synchronous in-memory helpers directly, which
 * meant that in pilot mode a patient's answers went to process memory — a
 * store the clinician never reads, that a restart empties, that nothing audits
 * or retains. The routes 404'd on a real database because the memory store was
 * empty. Every guarantee the pilot store provides was bypassed at the one
 * surface that matters most: the patient's own journey.
 *
 * Now every patient route resolves through `store()`, so demo and pilot run
 * the same code against different adapters.
 */

import { AppError } from "@/lib/errors";
import { store } from "@/lib/store";
import type { Actor } from "@/lib/store";
import type { IntakeBundle } from "@/lib/domain/types";

export interface PatientAccessContext {
  intakeId: string;
  practiceId: string;
  /** True once the second factor has been passed (always true in demo). */
  verified: boolean;
  /** The audit actor for this patient. */
  actor: Actor;
}

/**
 * Resolves a raw token to what it grants, applying expiry, revocation and the
 * lockout. Does NOT require the second factor — the GET view needs to load so
 * the patient can pass it. Callers that mutate use `requireVerifiedPatient`.
 */
export async function resolvePatientAccess(rawToken: string): Promise<PatientAccessContext> {
  const s = await store();
  const resolved = await s.resolveToken(rawToken);
  if (!resolved.ok) {
    if (resolved.reason === "expired") throw new AppError("INTAKE_EXPIRED", "token past expiry");
    if (resolved.reason === "revoked" || resolved.reason === "locked") {
      throw new AppError("INTAKE_REVOKED", `token ${resolved.reason}`);
    }
    throw new AppError("NOT_FOUND", "no such intake token");
  }
  return {
    intakeId: resolved.access.intakeId,
    practiceId: resolved.access.practiceId,
    verified: Boolean(resolved.access.verifiedAt),
    actor: { kind: "patient", intakeId: resolved.access.intakeId },
  };
}

/**
 * As above, but requires the second factor. Every state-changing patient route
 * uses this: an unverified token can view the verification prompt and nothing
 * else. In demo mode the memory adapter reports every token as verified, so a
 * conference link is not gated on a synthetic patient's date of birth.
 */
export async function requireVerifiedPatient(rawToken: string): Promise<PatientAccessContext> {
  const ctx = await resolvePatientAccess(rawToken);
  if (!ctx.verified) throw new AppError("VERIFICATION_REQUIRED", "second factor not yet passed");
  return ctx;
}

/** The current bundle for a resolved intake, or a 404 if it vanished. */
export async function patientBundle(intakeId: string): Promise<IntakeBundle> {
  const s = await store();
  const bundle = await s.bundleById(intakeId);
  if (!bundle) throw new AppError("NOT_FOUND", "intake not found");
  return bundle;
}
