/**
 * Clinician sessions.
 *
 * A signed, stateless cookie: the clinician id, their practice, and an
 * expiry, authenticated with HMAC-SHA256 over the whole payload. Stateless
 * because at pilot scale a session table buys nothing except another thing to
 * migrate, and revocation is already available where it matters — disabling
 * the account is checked on every request against the database.
 *
 * The practice id travels in the session because it is the tenant boundary,
 * and a boundary derived from a request parameter is not a boundary. Every
 * clinician query takes its practice from here, never from the URL.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export interface Session {
  clinicianId: string;
  practiceId: string;
  /** Epoch seconds. */
  exp: number;
  /** Random per-session value, used as the CSRF token. */
  csrf: string;
  /**
   * The account's session epoch at issue time. Compared against the row on
   * every request, so incrementing it on the account invalidates every cookie
   * already out there — which is what makes logout mean something.
   *
   * Optional on read: a cookie issued before this column existed has no epoch
   * and is treated as epoch 0, so a deploy does not sign every clinician out
   * mid-clinic.
   */
  epoch?: number;
}

export const SESSION_COOKIE = "aion_session";
export const CSRF_HEADER = "x-aion-csrf";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function issueSession(
  clinicianId: string,
  practiceId: string,
  secret: string,
  now: Date = new Date(),
  epoch = 0,
): { value: string; session: Session } {
  const session: Session = {
    clinicianId,
    practiceId,
    exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
    csrf: randomUUID(),
    epoch,
  };
  const payload = b64(JSON.stringify(session));
  return { value: `${payload}.${sign(payload, secret)}`, session };
}

/**
 * Verifies and decodes. Returns null for anything at all wrong — a bad
 * signature, a mangled payload, an expired session — because a caller that
 * cannot tell those apart cannot accidentally treat one as recoverable.
 */
export function readSession(value: string | undefined, secret: string, now: Date = new Date()): Session | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const supplied = value.slice(dot + 1);

  const expected = sign(payload, secret);
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(unb64(payload)) as Partial<Session>;
    if (
      typeof parsed.clinicianId !== "string" ||
      typeof parsed.practiceId !== "string" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.csrf !== "string"
    ) {
      return null;
    }
    if (parsed.exp * 1000 <= now.getTime()) return null;
    return parsed as Session;
  } catch {
    return null;
  }
}

/** Cookie attributes. Secure is dropped only for plain-HTTP local development. */
export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    // Lax, not Strict: a clinician following a link to a brief from their own
    // calendar should not land on a login page. Lax still withholds the cookie
    // from cross-site POSTs, which is the case that matters, and the CSRF
    // token below covers state-changing requests regardless.
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

/**
 * CSRF check for state-changing clinician requests.
 *
 * Double submit: the token is in the signed cookie and must be echoed in a
 * header, which a cross-site form post cannot set. Origin is checked too where
 * the browser sends it, because the two fail in different situations.
 */
export function csrfOk(session: Session, headerValue: string | null): boolean {
  if (!headerValue) return false;
  const a = Buffer.from(headerValue, "utf8");
  const b = Buffer.from(session.csrf, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function originOk(origin: string | null, host: string | null): boolean {
  // A missing Origin is normal for same-origin GETs and for non-browser
  // clients; the CSRF token is what actually gates state change, so a missing
  // header is not treated as a failure on its own.
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
