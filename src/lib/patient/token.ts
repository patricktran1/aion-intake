/**
 * Patient access tokens.
 *
 * The threat model's largest gap was that holding the link was the same as
 * being the patient: no expiry, no revocation, and the token stored in the
 * clear next to the record it opens. Four changes close most of it without
 * inventing an identity platform.
 *
 *   1. The token is 256 bits from the platform CSPRNG, base64url. Not
 *      sequential, not derived from anything, not enumerable.
 *   2. Only a peppered hash is stored. A dump of the intake table does not
 *      yield working links, and the pepper lives in the environment rather
 *      than the database, so it is not in the same dump.
 *   3. Every token carries an expiry and can be revoked, both checked on
 *      resolution rather than at issue time.
 *   4. Opening the intake requires a second factor the link does not contain.
 *
 * The second factor is the patient's date of birth, which the practice already
 * holds and the patient always knows. It is not identity proofing and is not
 * claimed to be: it stops a forwarded SMS from being enough, which is the
 * actual pilot threat. A practice-issued code is supported by the same
 * mechanism if a practice prefers one.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 bytes. Base64url so it survives being pasted into an SMS. */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Peppered SHA-256. A pepper rather than a per-row salt because lookup is by
 * token: we must be able to compute the hash from the token alone. SHA-256 is
 * appropriate here and bcrypt is not — the input is 256 bits of entropy, so
 * there is no dictionary to slow down, and the lookup is on the request path.
 */
export function hashToken(rawToken: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${rawToken}`).digest("hex");
}

/*
 * REMOVED: tokenHashEquals, a constant-time comparison of two token hashes.
 *
 * Nothing ever called it. It sat here making the design read as careful about
 * timing while the actual lookup is `WHERE token_hash = $1` in Postgres, which
 * is not constant time and does not need to be: the token is 256 bits from the
 * CSPRNG, so there is no candidate an attacker could steer a timing signal
 * toward. An unused security function is worse than none — a reviewer counts it
 * as a control, and it is protecting nothing.
 *
 * The comparisons that DO need to be constant time are in auth/password.ts,
 * auth/session.ts and patient/second-factor.ts, where the secret is short
 * enough for the guess to matter.
 */

/**
 * The second factor.
 *
 * Normalised before comparison so a patient typing 1986-03-10, 10/03/1986 or
 * 03/10/1986 is not defeated by punctuation. Ambiguous day/month ordering is
 * accepted in both readings on purpose: this is a possession check on someone
 * who already holds the link, not an identity assertion, and locking a patient
 * out of their own intake over date formatting is the worse failure.
 */
export function normalizeDob(input: string): string[] {
  const digits = input.replace(/\D+/g, "");
  if (digits.length !== 8) return [];
  // YYYYMMDD
  if (Number(digits.slice(0, 4)) > 1900) return [digits];
  // DDMMYYYY and MMDDYYYY both map to a YYYYMMDD candidate.
  const year = digits.slice(4);
  const a = digits.slice(0, 2);
  const b = digits.slice(2, 4);
  return [`${year}${b}${a}`, `${year}${a}${b}`];
}

/** True when `supplied` matches the stored date of birth in any reading. */
export function dobMatches(supplied: string, storedIso: string): boolean {
  const stored = storedIso.replace(/\D+/g, "").slice(0, 8);
  if (stored.length !== 8) return false;
  const candidates = normalizeDob(supplied);
  // Compare every candidate so the work does not vary with how early a match
  // is found. The set is at most two, so this stays trivial.
  let matched = false;
  for (const c of candidates) {
    const cb = Buffer.from(c, "utf8");
    const sb = Buffer.from(stored, "utf8");
    if (cb.length === sb.length && timingSafeEqual(cb, sb)) matched = true;
  }
  return matched;
}

/** After this many wrong answers the token is locked and must be reissued. */
export const MAX_VERIFICATION_ATTEMPTS = 5;

