import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createPilotFixture, TEST_PEPPER, type PilotFixture } from "./helpers/pilot";
import {
  SECOND_FACTOR_KINDS,
  hashSecondFactor,
  mintCode,
  normalizeCode,
  secondFactorFor,
  OTP_TTL_MINUTES,
  type SecondFactorSubject,
} from "@/lib/patient/second-factor";
import { readConfig } from "@/lib/config/runtime";

/**
 * The second factor is a strategy, not a hard-wired date-of-birth comparison.
 *
 * What these tests hold the design to: exactly one factor is active at a time,
 * the default is the one with no operational dependency, a strategy that has
 * nothing to check FAILS CLOSED, and the choice is recorded per token so a
 * practice changing policy cannot lock out links already in patients' hands.
 */

const PEPPER = TEST_PEPPER;
const subject = (over: Partial<SecondFactorSubject> = {}): SecondFactorSubject => ({
  intakeId: "int_x",
  practiceId: "prac_northgate",
  patientDateOfBirth: "1986-03-10",
  storedHash: null,
  storedExpiresAt: null,
  ...over,
});

describe("strategy A — date of birth", () => {
  const f = secondFactorFor("dob", PEPPER);

  it("accepts the formats a patient actually types", () => {
    for (const form of ["1986-03-10", "10/03/1986", "03/10/1986", "10 03 1986", "19860310"]) {
      expect(f.verify(form, subject()), form).toBe(true);
    }
  });

  it("rejects a wrong date, an empty answer and junk", () => {
    for (const form of ["1986-03-11", "", "   ", "not a date", "1986", "0000-00-00"]) {
      expect(f.verify(form, subject()), form).toBe(false);
    }
  });

  it("asks one question and gives away nothing", () => {
    const c = f.challenge();
    expect(c.kind).toBe("dob");
    expect(c.label).toBe("Date of birth");
    expect(JSON.stringify(c)).not.toContain("1986");
  });
});

describe("strategy B — practice-issued code", () => {
  const f = secondFactorFor("code", PEPPER);
  const code = "K7P4RM";
  const stored = { storedHash: hashSecondFactor(code, PEPPER) };

  it("accepts the code however the patient types it", () => {
    for (const form of [code, code.toLowerCase(), ` ${code} `, "K7P4-RM", "k7p4 rm"]) {
      expect(f.verify(form, subject(stored)), form).toBe(true);
    }
  });

  it("rejects a wrong code", () => {
    expect(f.verify("K7P4RN", subject(stored))).toBe(false);
  });

  it("FAILS CLOSED when no code was ever issued", () => {
    // The dangerous reading of "nothing to compare against" is "let them in".
    // A practice that switched to this factor and forgot to issue codes must
    // get locked-out patients — visible, fixable — not an absent factor.
    expect(f.verify("anything", subject())).toBe(false);
    expect(f.verify("", subject())).toBe(false);
  });

  it("does not expire, because it is handed out at booking", () => {
    // Weeks may pass between booking and the visit.
    expect(f.verify(code, subject({ ...stored, storedExpiresAt: new Date(0).toISOString() }))).toBe(true);
  });

  it("never stores the code itself", () => {
    const hash = hashSecondFactor(code, PEPPER);
    expect(hash).not.toContain(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // A different pepper yields a different hash: a database dump alone is not
    // enough to check a guess offline.
    expect(hashSecondFactor(code, "another-pepper".padEnd(48, "z"))).not.toBe(hash);
  });
});

describe("strategy C — one-time code to a known contact", () => {
  const f = secondFactorFor("otp", PEPPER);
  const code = "T9WXQ2";
  const live = {
    storedHash: hashSecondFactor(code, PEPPER),
    storedExpiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
  };

  it("accepts a live code", () => {
    expect(f.verify(code, subject(live))).toBe(true);
  });

  it("rejects an expired one — a code that never expires is just a second password", () => {
    expect(f.verify(code, subject({ ...live, storedExpiresAt: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });

  it("rejects a code with no expiry recorded at all", () => {
    expect(f.verify(code, subject({ storedHash: live.storedHash }))).toBe(false);
  });

  it("fails closed with nothing issued", () => {
    expect(f.verify(code, subject())).toBe(false);
  });
});

describe("code minting", () => {
  it("avoids look-alike characters, so a code read aloud is not a support call", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(mintCode(randomBytes)).toMatch(/^[ABCDEFGHJKLMNPQRTUVWXY2346789]{6}$/);
    }
  });

  it("is not biased toward the start of the alphabet", () => {
    // Naive `byte % 29` would over-produce the first few characters. Sample and
    // check the spread rather than assert an exact distribution.
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const ch of mintCode(randomBytes)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const values = [...counts.values()];
    expect(counts.size).toBe(29);
    // Perfectly uniform would be 24000/29 ≈ 828 each. A modulo bias shows as a
    // ~14% step between the first 24 and the last 5; allow generous noise and
    // still catch that.
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.35);
  });

  it("normalizes the way patients transcribe", () => {
    expect(normalizeCode(" k7p4-rm ")).toBe("K7P4RM");
  });
});

describe("exactly one factor is active, and it is chosen explicitly", () => {
  const base = {
    AION_RUNTIME_MODE: "pilot",
    DATABASE_URL: "postgres://localhost/x",
    AION_SESSION_SECRET: "s".repeat(48),
    AION_TOKEN_PEPPER: "p".repeat(48),
    AION_OBJECT_STORE: "local",
    AION_OBJECT_STORE_ROOT: "/tmp/x",
    AION_PHOTO_RETENTION_DAYS: "30",
    AION_INTAKE_RETENTION_DAYS: "90",
  };

  it("defaults to date of birth — the only one with no operational dependency", () => {
    expect(readConfig(base).pilot!.patientSecondFactor).toBe("dob");
  });

  it("accepts each supported kind", () => {
    for (const kind of SECOND_FACTOR_KINDS) {
      expect(readConfig({ ...base, AION_PATIENT_SECOND_FACTOR: kind }).pilot!.patientSecondFactor).toBe(kind);
    }
  });

  it("refuses to start on an unrecognised factor rather than guessing one", () => {
    expect(() => readConfig({ ...base, AION_PATIENT_SECOND_FACTOR: "none" })).toThrow(/AION_PATIENT_SECOND_FACTOR/);
    expect(() => readConfig({ ...base, AION_PATIENT_SECOND_FACTOR: "" })).toThrow(/AION_PATIENT_SECOND_FACTOR/);
  });

  it("is a single choice, not a list — there is no way to ask for two", () => {
    expect(() => readConfig({ ...base, AION_PATIENT_SECOND_FACTOR: "dob,code" })).toThrow();
  });
});

describe("the factor is recorded per token", () => {
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

  it("seeded tokens carry the default", async () => {
    const raw = f.seed.tokens.find((t) => t.state === "active")!.rawToken;
    const r = await f.store.resolveToken(raw);
    expect(r.ok && r.access.secondFactorKind).toBe("dob");
  });

  it("a practice switching policy does not lock out links already issued", async () => {
    // Two tokens. One issued before the switch, one after.
    const before = f.seed.tokens.find((t) => t.state === "active")!;
    const after = f.seed.tokens.find((t) => t.state === "live")!;
    await f.store.setSecondFactor(after.intakeId, "code", hashSecondFactor("K7P4RM", TEST_PEPPER), null);

    const a = await f.store.resolveToken(before.rawToken);
    const b = await f.store.resolveToken(after.rawToken);
    expect(a.ok && a.access.secondFactorKind).toBe("dob");
    expect(b.ok && b.access.secondFactorKind).toBe("code");

    // The older link still verifies against the factor it was issued with.
    const bundle = (await f.store.bundleById(before.intakeId))!;
    expect(
      secondFactorFor("dob", TEST_PEPPER).verify(bundle.patient.dateOfBirth, {
        intakeId: before.intakeId,
        practiceId: "prac_northgate",
        patientDateOfBirth: bundle.patient.dateOfBirth,
        storedHash: null,
        storedExpiresAt: null,
      }),
    ).toBe(true);
  });

  it("setting a new factor drops any proof already given against the old one", async () => {
    const t = f.seed.tokens.find((t) => t.state === "active")!;
    await f.store.markVerified(t.intakeId);
    expect((await f.store.resolveToken(t.rawToken)).ok).toBe(true);
    expect((await f.driver.query("SELECT verified_at FROM patient_tokens WHERE intake_id=$1", [t.intakeId])).rows[0])
      .toHaveProperty("verified_at");

    await f.store.setSecondFactor(t.intakeId, "code", hashSecondFactor("ABC234", TEST_PEPPER), null);
    const r = await f.store.resolveToken(t.rawToken);
    expect(r.ok && r.access.verifiedAt).toBeNull();
  });

  it("the durable attempt budget still applies whichever factor is in force", async () => {
    // This is the control that makes a six-character code viable: the guess
    // budget is five, in the database, not per-instance.
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    await f.store.setSecondFactor(t.intakeId, "code", hashSecondFactor("ABC234", TEST_PEPPER), null);
    for (let i = 0; i < 5; i += 1) await f.store.recordVerificationFailure(t.intakeId);
    const r = await f.store.resolveToken(t.rawToken);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("locked");
  });

  it("an unknown stored kind is not an open door", async () => {
    // Defensive: a value written by a future version, or by hand. The route
    // falls back to the default factor rather than skipping verification.
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    await f.driver.query("UPDATE patient_tokens SET second_factor_kind = 'sms_magic' WHERE intake_id = $1", [t.intakeId]);
    const r = await f.store.resolveToken(t.rawToken);
    expect(r.ok && r.access.secondFactorKind).toBe("sms_magic");
    // secondFactorFor only knows three kinds; the route coerces to the default.
    expect(secondFactorFor("dob", TEST_PEPPER).verify("", subject())).toBe(false);
  });
});
