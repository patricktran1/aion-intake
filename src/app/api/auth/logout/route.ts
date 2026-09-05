import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { handle, jsonOk } from "@/lib/http";
import { requirePilotMode } from "@/lib/auth/guard";
import { SESSION_COOKIE, readSession } from "@/lib/auth/session";
import { pilotConfig } from "@/lib/config/runtime";
import { store } from "@/lib/store";
import { audit } from "@/lib/audit";

/**
 * Ends the session — on the server, not only in this browser.
 *
 * Clearing the cookie used to be the whole of it, which meant the cookie
 * itself stayed valid for the rest of its twelve hours. Anyone who had
 * captured it — a shared machine, a proxy log, a screen recording — could keep
 * reading patient histories after the clinician had signed out and believed
 * they were done. Incrementing the account's session epoch invalidates every
 * cookie already issued for it.
 *
 * Still does not require a valid session: signing out must work from a stale
 * or half-broken state, and it is not a state-changing action anyone would
 * want to force on someone else.
 */
export async function POST(req: Request) {
  return handle(req, "POST /api/auth/logout", async ({ requestId }) => {
    requirePilotMode();

    const jar = await cookies();
    const session = readSession(jar.get(SESSION_COOKIE)?.value, pilotConfig().sessionSecret);
    if (session) {
      const s = await store();
      await s.bumpSessionEpoch(session.clinicianId);
      await audit({
        action: "auth.logout",
        actor: { kind: "clinician", clinicianId: session.clinicianId, practiceId: session.practiceId },
        practiceId: session.practiceId,
        resource: "clinician",
        resourceId: session.clinicianId,
        requestId,
      });
    }

    const res = jsonOk({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    return res as NextResponse;
  });
}
