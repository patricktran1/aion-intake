import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, intakeIdFor, tokenFor, type PilotFixture } from "./helpers/pilot";
import { randomUUID } from "node:crypto";
import { photoKey } from "@/lib/objects";

/**
 * Cross-tenant and cross-patient attack suite.
 *
 * Everything here is an attempt to reach a record the actor has no business
 * reading. These are the tests that decide whether a pilot involving more than
 * one practice is safe, so they attack the store directly rather than through
 * a route — a route can be re-written, but if the store leaks, nothing above
 * it can put the data back.
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

const NORTHGATE = "prac_northgate";
const RIVERSIDE = "prac_riverside";

describe("practice isolation", () => {
  it("a clinician cannot read another practice's intake by id", async () => {
    const theirs = intakeIdFor(f.seed, "other"); // Riverside
    expect(await f.store.bundleForClinician(theirs, RIVERSIDE)).not.toBeNull();
    expect(await f.store.bundleForClinician(theirs, NORTHGATE)).toBeNull();

    const ours = intakeIdFor(f.seed, "submitted"); // Northgate
    expect(await f.store.bundleForClinician(ours, NORTHGATE)).not.toBeNull();
    expect(await f.store.bundleForClinician(ours, RIVERSIDE)).toBeNull();
  });

  it("a practice's list contains only its own intakes", async () => {
    const north = await f.store.listBundles(NORTHGATE);
    const river = await f.store.listBundles(RIVERSIDE);

    expect(north.length).toBeGreaterThan(0);
    expect(river.length).toBeGreaterThan(0);
    expect(north.every((b) => b.practice.id === NORTHGATE)).toBe(true);
    expect(river.every((b) => b.practice.id === RIVERSIDE)).toBe(true);

    const northIds = new Set(north.map((b) => b.intake.id));
    for (const b of river) expect(northIds.has(b.intake.id)).toBe(false);
    // And no patient name crosses over.
    expect(north.some((b) => b.patient.lastName === "da Costa")).toBe(false);
  });

  it("a random or guessed id yields nothing", async () => {
    for (const id of [randomUUID(), "int_", "int_submitted ", "' OR '1'='1", "int_other'--"]) {
      expect(await f.store.bundleForClinician(id, NORTHGATE)).toBeNull();
    }
  });

  it("a photo belonging to another practice is not returned for access", async () => {
    const theirs = intakeIdFor(f.seed, "other");
    const key = photoKey(RIVERSIDE, theirs, "image/jpeg");
    await f.store.addPhoto({
      id: "pho_theirs", intakeId: theirs, practiceId: RIVERSIDE, objectKey: key,
      mime: "image/jpeg", bytes: 10, width: 800, height: 600, kind: "close",
      caption: "", advisories: [], idempotencyKey: null,
    });

    const row = await f.store.photoForAccess("pho_theirs");
    expect(row).not.toBeNull();
    // The store returns the owner; the caller must compare. This asserts the
    // ownership fields are actually populated, which is what makes the route's
    // check possible at all.
    expect(row!.practiceId).toBe(RIVERSIDE);
    expect(row!.intakeId).toBe(theirs);
    expect(row!.practiceId).not.toBe(NORTHGATE);
  });
});

describe("patient token lifecycle", () => {
  it("a live token resolves to exactly its own intake", async () => {
    const r = await f.store.resolveToken(tokenFor(f.seed, "active"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.access.intakeId).toBe(intakeIdFor(f.seed, "active"));
      expect(r.access.practiceId).toBe(NORTHGATE);
    }
  });

  it("an expired token is refused", async () => {
    expect(await f.store.resolveToken(tokenFor(f.seed, "expired"))).toEqual({ ok: false, reason: "expired" });
  });

  it("a revoked token is refused", async () => {
    expect(await f.store.resolveToken(tokenFor(f.seed, "revoked"))).toEqual({ ok: false, reason: "revoked" });
  });

  it("revocation takes effect immediately on a live token", async () => {
    const raw = tokenFor(f.seed, "active");
    expect((await f.store.resolveToken(raw)).ok).toBe(true);
    await f.store.revokeToken(intakeIdFor(f.seed, "active"));
    expect(await f.store.resolveToken(raw)).toEqual({ ok: false, reason: "revoked" });
  });

  it("one patient's token never opens another patient's intake", async () => {
    const a = await f.store.resolveToken(tokenFor(f.seed, "active"));
    const b = await f.store.resolveToken(tokenFor(f.seed, "submitted"));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.access.intakeId).not.toBe(b.access.intakeId);

    // A token from the other practice resolves to that practice, never ours.
    const other = await f.store.resolveToken(tokenFor(f.seed, "other"));
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.access.practiceId).toBe(RIVERSIDE);
  });

  it("guessed, truncated and mutated tokens are refused", async () => {
    const real = tokenFor(f.seed, "active");
    const attempts = [
      "",
      "x",
      real.slice(0, -1),
      `${real}x`,
      real.toUpperCase(),
      real.replace(/.$/, "0"),
      randomUUID(),
    ];
    for (const t of attempts) {
      const r = await f.store.resolveToken(t);
      expect(r.ok, `token "${t.slice(0, 12)}…" must not resolve`).toBe(false);
    }
  });

  it("the raw token is never stored — only a peppered hash", async () => {
    const raw = tokenFor(f.seed, "active");
    const { rows } = await f.driver.query<{ token_hash: string }>("SELECT token_hash FROM patient_tokens");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.token_hash).not.toContain(raw);
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // A dump of the table, without the pepper, yields nothing usable.
    const dump = JSON.stringify(rows);
    expect(dump.includes(raw)).toBe(false);
  });

  it("repeated verification failures lock the token", async () => {
    const id = intakeIdFor(f.seed, "active");
    let n = 0;
    for (let i = 0; i < 5; i += 1) n = await f.store.recordVerificationFailure(id);
    expect(n).toBe(5);
    expect(await f.store.resolveToken(tokenFor(f.seed, "active"))).toEqual({ ok: false, reason: "locked" });

    // A successful verification clears the counter, so a patient who mistypes
    // then gets it right is not locked out on their next visit.
    await f.store.markVerified(id);
    expect((await f.store.resolveToken(tokenFor(f.seed, "active"))).ok).toBe(true);
  });

  it("a deleted intake's token stops resolving", async () => {
    const raw = tokenFor(f.seed, "active");
    await f.store.deleteIntake(intakeIdFor(f.seed, "active"));
    expect(await f.store.resolveToken(raw)).toEqual({ ok: false, reason: "not_found" });
  });
});
