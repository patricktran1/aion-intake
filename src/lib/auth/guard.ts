/**
 * Route-level authorization.
 *
 * Four kinds of route, and each one gets a function here rather than an
 * inline check, so "which routes are protected" is answerable by grepping for
 * these names instead of reading thirteen files. ROUTES.md records the matrix
 * and `tests/pilot-routes.test.ts` asserts it.
 *
 *   requireClinician   a signed-in clinician; returns their practice, which is
 *                      the tenant boundary every downstream query uses.
 *   requirePatient     a live, verified patient token for one intake.
 *   requireDemoMode    demo-only routes (reset), refused in pilot.
 *   requirePilotMode   pilot-only routes (login, photo bytes), 404 in demo.
 */

import { cookies } from "next/headers";
import { AppError } from "@/lib/errors";
import { isPilot, pilotConfig } from "@/lib/config/runtime";
import { store } from "@/lib/store";
import type { Actor } from "@/lib/store";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  csrfOk,
  originOk,
  readSession,
  type Session,
} from "./session";
import { audit } from "@/lib/audit";

export interface ClinicianContext {
  session: Session;
  actor: Extract<Actor, { kind: "clinician" }>;
  practiceId: string;
  displayName: string;
  credential: string;
}

/**
 * A signed-in clinician, or a thrown AUTH_REQUIRED.
 *
 * The account is re-read from the database on every request, so disabling one
 * takes effect immediately rather than when its cookie happens to expire.
 * That is the only revocation a stateless session needs, and it is the one
 * that matters when someone leaves a practice.
 */
export async function requireClinician(): Promise<ClinicianContext> {
  if (!isPilot()) throw new AppError("NOT_AVAILABLE_IN_THIS_MODE", "clinician auth is pilot-only");

  const jar = await cookies();
  const session = readSession(jar.get(SESSION_COOKIE)?.value, pilotConfig().sessionSecret);
  if (!session) throw new AppError("AUTH_REQUIRED", "no valid session cookie");

  const s = await store();
  const account = await s.clinicianById(session.clinicianId);
  if (!account || account.disabledAt) {
    await audit({
      action: "authz.denied",
      actor: { kind: "anonymous" },
      resource: "clinician",
      resourceId: session.clinicianId,
      meta: { reason: account ? "disabled" : "unknown_account" },
    });
    throw new AppError("AUTH_REQUIRED", "account missing or disabled");
  }
  // A session's practice must still match the account's. If a clinician moved
  // practices, the old session must not carry the old tenancy.
  if (account.practiceId !== session.practiceId) {
    throw new AppError("AUTH_REQUIRED", "session practice no longer matches account");
  }
  // And the cookie must be from the current epoch. Logout increments it, so a
  // cookie captured before a clinician signed out stops working at the moment
  // they signed out rather than twelve hours later. A cookie issued before this
  // column existed carries no epoch and reads as 0, so a deploy does not sign
  // everyone out mid-clinic.
  if ((session.epoch ?? 0) !== account.sessionEpoch) {
    throw new AppError("AUTH_REQUIRED", "session invalidated");
  }

  return {
    session,
    actor: { kind: "clinician", clinicianId: account.id, practiceId: account.practiceId },
    practiceId: account.practiceId,
    displayName: account.displayName,
    credential: account.credential,
  };
}

/**
 * CSRF for state-changing clinician requests: the session's token echoed in a
 * header a cross-site form cannot set, plus an Origin check where the browser
 * sends one.
 */
export function requireCsrf(req: Request, ctx: ClinicianContext): void {
  if (!originOk(req.headers.get("origin"), req.headers.get("host"))) {
    throw new AppError("ACCESS_DENIED", "cross-origin request");
  }
  if (!csrfOk(ctx.session, req.headers.get(CSRF_HEADER))) {
    throw new AppError("ACCESS_DENIED", "missing or invalid csrf token");
  }
}

export interface PatientContext {
  intakeId: string;
  practiceId: string;
  actor: Extract<Actor, { kind: "patient" }>;
}

/**
 * A live patient token for one intake.
 *
 * In pilot mode this also requires that the second factor has been passed for
 * this token; in demo mode the memory adapter reports every token as verified,
 * which keeps conference links working.
 */
export async function requirePatient(rawToken: string): Promise<PatientContext> {
  const s = await store();
  const resolved = await s.resolveToken(rawToken);
  if (!resolved.ok) {
    if (resolved.reason === "expired") throw new AppError("INTAKE_EXPIRED", "token past expiry");
    if (resolved.reason === "revoked" || resolved.reason === "locked") {
      throw new AppError("INTAKE_REVOKED", `token ${resolved.reason}`);
    }
    throw new AppError("NOT_FOUND", "no such intake token");
  }
  if (!resolved.access.verifiedAt) {
    throw new AppError("VERIFICATION_REQUIRED", "second factor not yet passed");
  }
  return {
    intakeId: resolved.access.intakeId,
    practiceId: resolved.access.practiceId,
    actor: { kind: "patient", intakeId: resolved.access.intakeId },
  };
}

export function requireDemoMode(): void {
  if (isPilot()) throw new AppError("NOT_AVAILABLE_IN_THIS_MODE", "demo-only route");
}

export function requirePilotMode(): void {
  if (!isPilot()) throw new AppError("NOT_AVAILABLE_IN_THIS_MODE", "pilot-only route");
}
