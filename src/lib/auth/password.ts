/**
 * Password verification for pilot clinician accounts.
 *
 * scrypt from the platform's own crypto module, with the parameters and the
 * salt stored alongside the hash. This is not custom cryptography: no
 * primitive is being designed, combined, or tuned here — it is the standard
 * memory-hard KDF called the standard way, with a constant-time comparison.
 *
 * The intended endpoint is an OIDC provider, where a practice's own identity
 * system holds the credential and this file disappears. That integration is a
 * contract and a tenant configuration away, and blocking every other part of
 * the pilot on it would be the wrong trade — so local accounts exist, they are
 * honest about being local, and `verifySession` below is the seam an OIDC
 * provider plugs into without touching a route.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** OWASP's current floor for scrypt. Recorded per-hash so it can be raised. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  if (expected.length !== KEYLEN) return false;
  try {
    const actual = await scrypt(password, salt, KEYLEN, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A password to compare against when the account does not exist, so that a
 * login attempt costs the same whether or not the email is registered. Without
 * it, response time answers "is this address a clinician here".
 */
export const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("must be at least 12 characters");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push("must mix upper and lower case");
  if (!/\d/.test(password)) problems.push("must contain a digit");
  return problems;
}
