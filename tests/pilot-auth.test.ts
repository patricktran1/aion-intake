import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, TEST_SESSION_SECRET, type PilotFixture } from "./helpers/pilot";
import { SEED_PASSWORD } from "@/lib/db/seed-pilot";
import { DUMMY_HASH, hashPassword, passwordProblems, verifyPassword } from "@/lib/auth/password";
import {
  CSRF_HEADER,
  SESSION_TTL_SECONDS,
  csrfOk,
  issueSession,
  originOk,
  readSession,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { dobMatches, hashToken, mintToken, normalizeDob } from "@/lib/patient/token";

/**
 * Clinician identity and patient verification.
 *
 * The shared passphrase this replaces was not authentication and never claimed
 * to be. What matters now is that the replacement fails closed everywhere it
 * can be attacked: a forged cookie, an expired one, a cookie from a different
 * deployment, a cross-site post, a guessed password, a forwarded intake link.
 */

let f: PilotFixture;
beforeAll(async () => {
  f = await createPilotFixture();
}, 60_000);
afterAll(async () => {
  await f.dispose();
});
beforeEach(async () => {
  await f.reseed();
});

describe("password storage", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("CorrectHorse12");
    expect(await verifyPassword("CorrectHorse12", hash)).toBe(true);
    expect(await verifyPassword("correcthorse12", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  }, 30_000);

  it("produces a different hash every time, so equal passwords are not equal rows", async () => {
    const [a, b] = await Promise.all([hashPassword("SamePassword1"), hashPassword("SamePassword1")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("SamePassword1", a)).toBe(true);
    expect(await verifyPassword("SamePassword1", b)).toBe(true);
  }, 30_000);

  it("rejects a malformed or truncated stored hash instead of throwing", async () => {
    for (const bad of ["", "not-a-hash", "scrypt$1$2$3", "scrypt$32768$8$1$AAAA$AAAA", "$$$$$"]) {
      expect(await verifyPassword("whatever", bad)).toBe(false);
    }
  }, 30_000);

  it("the dummy hash verifies nothing but is well formed", async () => {
    // Its purpose is to make a login attempt for an unknown address cost the
    // same as one for a known address. It must therefore parse, and fail.
    expect(await verifyPassword("anything", DUMMY_HASH)).toBe(false);
    expect(DUMMY_HASH.split("$")).toHaveLength(6);
  }, 30_000);

  it("requires a password with some substance", () => {
    expect(passwordProblems("short")).not.toHaveLength(0);
    expect(passwordProblems("alllowercase123")).not.toHaveLength(0);
    expect(passwordProblems("NoDigitsHereAtAll")).not.toHaveLength(0);
    expect(passwordProblems("SyntheticPilot1")).toHaveLength(0);
  });

  it("the seeded clinician can be authenticated from the database", async () => {
    const account = await f.store.clinicianByEmail("okonkwo@northgate.example");
    expect(account).not.toBeNull();
    expect(account!.practiceId).toBe("prac_northgate");
    expect(await verifyPassword(SEED_PASSWORD, account!.passwordHash)).toBe(true);
    expect(await verifyPassword("wrong", account!.passwordHash)).toBe(false);
    // Email lookup is case-insensitive; a clinician typing their address in
    // caps at 7am should not be told their account does not exist.
    expect(await f.store.clinicianByEmail("OKONKWO@NORTHGATE.EXAMPLE")).not.toBeNull();
  }, 30_000);

  it("stores no plaintext password anywhere in the table", async () => {
    const { rows } = await f.driver.query<{ password_hash: string }>("SELECT password_hash FROM clinicians");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.password_hash).not.toContain(SEED_PASSWORD);
      expect(r.password_hash.startsWith("scrypt$")).toBe(true);
    }
  });
});

describe("sessions", () => {
  it("round-trips a session and carries the practice boundary", () => {
    const { value, session } = issueSession("cli_okonkwo", "prac_northgate", TEST_SESSION_SECRET);
    const read = readSession(value, TEST_SESSION_SECRET);
    expect(read).not.toBeNull();
    expect(read!.clinicianId).toBe("cli_okonkwo");
    expect(read!.practiceId).toBe("prac_northgate");
    expect(read!.csrf).toBe(session.csrf);
  });

  it("rejects a tampered payload, a tampered signature, and a foreign secret", () => {
    const { value } = issueSession("cli_okonkwo", "prac_northgate", TEST_SESSION_SECRET);
    const [payload, sig] = value.split(".");

    // Re-signing a payload that claims a different practice requires the
    // secret; without it the escalation is rejected.
    const forged = Buffer.from(
      JSON.stringify({ clinicianId: "cli_okonkwo", practiceId: "prac_riverside", exp: 2 ** 31, csrf: "x" }),
      "utf8",
    ).toString("base64url");
    expect(readSession(`${forged}.${sig}`, TEST_SESSION_SECRET)).toBeNull();
    expect(readSession(`${payload}.${sig}x`, TEST_SESSION_SECRET)).toBeNull();
    expect(readSession(value, "a-completely-different-secret-value-here")).toBeNull();
    for (const junk of ["", ".", "no-dot", "a.b", "....."]) {
      expect(readSession(junk, TEST_SESSION_SECRET)).toBeNull();
    }
  });

  it("rejects an expired session", () => {
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    const { value } = issueSession("cli_okonkwo", "prac_northgate", TEST_SESSION_SECRET, issuedAt);
    const justInside = new Date(issuedAt.getTime() + (SESSION_TTL_SECONDS - 60) * 1000);
    const justOutside = new Date(issuedAt.getTime() + (SESSION_TTL_SECONDS + 60) * 1000);
    expect(readSession(value, TEST_SESSION_SECRET, justInside)).not.toBeNull();
    expect(readSession(value, TEST_SESSION_SECRET, justOutside)).toBeNull();
  });

  it("sets cookie attributes that a browser will actually protect", () => {
    const opts = sessionCookieOptions(true);
    expect(opts.httpOnly).toBe(true);
    expect(opts.secure).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.maxAge).toBe(SESSION_TTL_SECONDS);
    // Only plain-HTTP local development drops Secure.
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});

describe("CSRF and origin", () => {
  it("accepts only the session's own token", () => {
    const { session } = issueSession("cli_okonkwo", "prac_northgate", TEST_SESSION_SECRET);
    expect(csrfOk(session, session.csrf)).toBe(true);
    expect(csrfOk(session, null)).toBe(false);
    expect(csrfOk(session, "")).toBe(false);
    expect(csrfOk(session, `${session.csrf}x`)).toBe(false);
    const other = issueSession("cli_bell", "prac_northgate", TEST_SESSION_SECRET).session;
    expect(csrfOk(session, other.csrf)).toBe(false);
  });

  it("rejects a cross-site origin and allows the same host", () => {
    expect(originOk("https://aion.example", "aion.example")).toBe(true);
    expect(originOk("https://evil.example", "aion.example")).toBe(false);
    expect(originOk("https://aion.example.evil.test", "aion.example")).toBe(false);
    // A missing Origin is normal for same-origin GETs and non-browser clients;
    // the CSRF token is what gates state change.
    expect(originOk(null, "aion.example")).toBe(true);
    expect(originOk("not a url", "aion.example")).toBe(false);
  });

  it("names the header a cross-site form cannot set", () => {
    expect(CSRF_HEADER.startsWith("x-")).toBe(true);
  });
});

describe("patient verification", () => {
  it("matches a date of birth across the formats a patient might type", () => {
    for (const typed of ["1991-04-12", "19910412", "12/04/1991", "04/12/1991", "12-04-1991"]) {
      expect(dobMatches(typed, "1991-04-12"), typed).toBe(true);
    }
  });

  it("rejects a wrong or unparseable date of birth", () => {
    for (const typed of ["1991-04-13", "1990-04-12", "", "12/04", "not a date", "199104123"]) {
      expect(dobMatches(typed, "1991-04-12"), typed).toBe(false);
    }
  });

  it("normalises ambiguous dates in both readings and unambiguous ones exactly", () => {
    expect(normalizeDob("19910412")).toEqual(["19910412"]);
    expect(normalizeDob("12041991")).toEqual(["19910412", "19911204"]);
    expect(normalizeDob("nonsense")).toEqual([]);
  });

  it("tokens are long, random, and hash differently under different peppers", () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);

    const h1 = hashToken(a, "pepper-one".padEnd(40, "x"));
    const h2 = hashToken(a, "pepper-two".padEnd(40, "y"));
    expect(h1).not.toBe(h2);
    // Rotating the pepper invalidates every outstanding link, which is the
    // intended emergency lever and worth knowing is real.
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
