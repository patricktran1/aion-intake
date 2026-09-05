import { NextResponse } from "next/server";
import { handle, jsonOk, readJson } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { requirePilotMode } from "@/lib/auth/guard";
import { pilotConfig } from "@/lib/config/runtime";
import { store } from "@/lib/store";
import { DUMMY_HASH, verifyPassword } from "@/lib/auth/password";
import { SESSION_COOKIE, issueSession, sessionCookieOptions } from "@/lib/auth/session";
import { LIMITS, loginKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";
import { audit } from "@/lib/audit";

/**
 * Clinician sign-in. Pilot only — the demo's gate is the middleware passphrase.
 *
 * Two properties worth naming: a failed attempt never says whether the address
 * exists, and it costs the same either way (an unknown address is verified
 * against a dummy hash), so the endpoint cannot be used to enumerate the
 * clinicians at a practice.
 */
export async function POST(req: Request) {
  return handle(req, "POST /api/auth/login", async ({ requestId }) => {
    requirePilotMode();

    const body = await readJson(req);
    const b = (body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof b.email === "string" ? b.email.trim().slice(0, 200) : "";
    const password = typeof b.password === "string" ? b.password.slice(0, 400) : "";
    if (!email || !password) throw new AppError("BAD_REQUEST", "email and password required");

    // Keyed by address so one account under attack cannot lock out a practice,
    // and separately by nothing else — a shared clinic IP is one office.
    if (!(await enforce(loginKey(email), LIMITS.login))) {
      throw new AppError("RATE_LIMITED", "too many login attempts");
    }

    const s = await store();
    const account = await s.clinicianByEmail(email);
    const ok = await verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);

    if (!account || !ok || account.disabledAt) {
      await audit({
        action: "auth.login_failed",
        actor: { kind: "anonymous" },
        resource: "clinician",
        resourceId: account?.id ?? null,
        practiceId: account?.practiceId ?? null,
        requestId,
        meta: { reason: account ? (account.disabledAt ? "disabled" : "bad_password") : "unknown" },
      });
      // One message for every failure mode.
      throw new AppError("AUTH_REQUIRED", "login failed");
    }

    // The account's current epoch is stamped into the cookie, so a later logout
    // (which increments it) invalidates this one on the server.
    const { value, session } = issueSession(
      account.id,
      account.practiceId,
      pilotConfig().sessionSecret,
      new Date(),
      account.sessionEpoch,
    );
    await audit({
      action: "auth.login",
      actor: { kind: "clinician", clinicianId: account.id, practiceId: account.practiceId },
      resource: "clinician",
      resourceId: account.id,
      requestId,
    });

    const res = jsonOk({
      clinician: { id: account.id, displayName: account.displayName, credential: account.credential },
      practiceId: account.practiceId,
      // The browser echoes this on state-changing requests. It is not a secret
      // from the page — only from another origin, which cannot read it.
      csrfToken: session.csrf,
    });
    res.cookies.set(SESSION_COOKIE, value, sessionCookieOptions(new URL(req.url).protocol === "https:"));
    return res as NextResponse;
  });
}
