/**
 * The clinician scope for a request.
 *
 * Demo and pilot answer "who is asking, and what may they see" differently,
 * and the difference is confined here so the routes above do not each carry a
 * mode check:
 *
 *   demo   The middleware passphrase is the whole gate. There is one synthetic
 *          practice, no accounts, and no tenant boundary to enforce, so the
 *          scope is null and the store returns everything.
 *   pilot  A signed-in clinician, with the practice id from their session.
 *          Every query downstream is scoped to it.
 *
 * A route asks for a scope and uses `practiceId` verbatim. It must never read
 * a practice from a query parameter or a body — a tenant boundary taken from
 * the request is not a boundary.
 */

import { isPilot } from "@/lib/config/runtime";
import type { Actor } from "@/lib/store";
import { requireClinician, requireCsrf, type ClinicianContext } from "./guard";

export interface ClinicianScope {
  /** Null in demo mode, where there is one synthetic practice. */
  practiceId: string | null;
  actor: Actor;
  /** Present only in pilot mode; carries the session for CSRF checks. */
  ctx: ClinicianContext | null;
}

export async function clinicianScope(req: Request): Promise<ClinicianScope> {
  if (!isPilot()) {
    return { practiceId: null, actor: { kind: "system" }, ctx: null };
  }
  const ctx = await requireClinician(req);
  return { practiceId: ctx.practiceId, actor: ctx.actor, ctx };
}

/**
 * As above, but for a state-changing request: pilot mode additionally requires
 * the CSRF token and a same-origin request. Demo mode has no session to forge
 * and no tenant to cross.
 */
export async function clinicianWriteScope(req: Request): Promise<ClinicianScope> {
  const scope = await clinicianScope(req);
  if (scope.ctx) requireCsrf(req, scope.ctx);
  return scope;
}
