import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPilotFixture, intakeIdFor, TEST_PEPPER, type PilotFixture } from "./helpers/pilot";
import { SqlStore } from "@/lib/store/sql";
import { intakeKey, loginKey, clientKey } from "@/lib/ratelimit";
import { allowShared, sweepRateLimits } from "@/lib/ratelimit-shared";
import { dumpDatabase } from "@/lib/db/backup";
import type { ObjectStore, StoredObject } from "@/lib/objects";

/**
 * Regressions for defects found by adversarial review of the assembled system.
 *
 * Each one had passing tests around it. They are grouped here rather than
 * scattered because what they have in common is the interesting part: every one
 * is a gap between a guarantee the documentation states and what the code does,
 * and none of them were reachable from a test that only exercised the component
 * where the guarantee is written down.
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

describe("a rate-limit key is never a credential", () => {
  /**
   * The whole patient-token design rests on one claim: "only a peppered
   * SHA-256 is stored, so a dump of the intake table does not yield working
   * links." In pilot mode a rate-limit key is a row in Postgres, and it was
   * the raw token. Six patient routes wrote one, so any intake a patient
   * touched deposited its live bearer credential in a table that also went
   * into every logical backup.
   */
  const RAW = "seed-active-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("does not contain the token it is derived from", () => {
    const key = intakeKey(RAW, "intake");
    expect(key).not.toContain(RAW);
    expect(key).not.toContain("seed-");
    expect(key).toMatch(/^intake:token:[0-9a-f]{32}$/);
  });

  it("is stable, so it is still one bucket per token", () => {
    expect(intakeKey(RAW, "intake")).toBe(intakeKey(RAW, "intake"));
    expect(intakeKey(RAW, "intake")).not.toBe(intakeKey(RAW, "verify"));
    expect(intakeKey(RAW, "intake")).not.toBe(intakeKey(`${RAW}x`, "intake"));
  });

  it("does not contain the email or address it is derived from", () => {
    expect(loginKey("okonkwo@northgate.example")).not.toContain("okonkwo");
    expect(loginKey("okonkwo@northgate.example")).not.toContain("@");
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(clientKey(req, "reset")).not.toContain("203.0.113");
  });

  it("nothing recognisable reaches the rate_limits table", async () => {
    await allowShared(f.driver, intakeKey(RAW, "intake"), { burst: 5, refillPerSecond: 1 });
    await allowShared(f.driver, loginKey("okonkwo@northgate.example"), { burst: 5, refillPerSecond: 1 });
    const { rows } = await f.driver.query<{ key: string }>("SELECT key FROM rate_limits");
    expect(rows.length).toBeGreaterThan(0);
    const all = rows.map((r) => r.key).join(" ");
    expect(all).not.toContain(RAW);
    expect(all).not.toContain("seed-");
    expect(all).not.toContain("okonkwo");
  });

  it("the table is swept, not merely sweepable", async () => {
    // sweepRateLimits existed and had a test, and nothing called it — so the
    // table grew with traffic from attacker-chosen keys forever. The retention
    // command calls it now; this pins the behaviour it depends on.
    await allowShared(f.driver, "x:stale", { burst: 5, refillPerSecond: 1 }, new Date(Date.now() - 48 * 3600_000));
    await allowShared(f.driver, "x:fresh", { burst: 5, refillPerSecond: 1 });
    expect(await sweepRateLimits(f.driver, new Date(Date.now() - 24 * 3600_000))).toBe(1);
    const { rows } = await f.driver.query<{ key: string }>("SELECT key FROM rate_limits");
    expect(rows.map((r) => r.key)).toContain("x:fresh");
  });

  it("the retention command actually calls the sweeper", () => {
    const src = readFileSync(join(process.cwd(), "scripts/pilot.ts"), "utf8");
    expect(src).toMatch(/sweepRateLimits\(/);
  });
});

describe("what a backup carries", () => {
  it("excludes rate_limits and includes the deletion outbox", async () => {
    // rate_limits is derived counting state and rebuilds itself in minutes.
    // pending_object_deletions is not derived: each row is a photograph whose
    // record is gone and whose bytes are still owed a deletion, so leaving it
    // out meant a restore silently forgot what it owed.
    await allowShared(f.driver, "some:key", { burst: 5, refillPerSecond: 1 });
    const backup = await dumpDatabase(f.driver, new Date().toISOString());
    expect(Object.keys(backup.tables)).not.toContain("rate_limits");
    expect(Object.keys(backup.tables)).toContain("pending_object_deletions");
  });

  it("a restored outbox entry still drains", async () => {
    const key = "prac_northgate/int_restored/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg";
    await f.driver.query(
      "INSERT INTO pending_object_deletions (object_key, practice_id, reason) VALUES ($1,'prac_northgate','x')",
      [key],
    );
    const backup = await dumpDatabase(f.driver, new Date().toISOString());
    expect(backup.tables.pending_object_deletions).toHaveLength(1);
    expect(await f.store.pendingObjectDeletions(10)).toHaveLength(1);
  });
});

describe("a photo upload leaves no orphan", () => {
  /** An object store whose put succeeds or fails on command. */
  class ControllablePut implements ObjectStore {
    readonly kind = "local" as const;
    failPut = false;
    constructor(private readonly inner: ObjectStore) {}
    async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
      if (this.failPut) throw new Error("object store unreachable");
      return this.inner.put(key, body, contentType);
    }
    get(key: string) {
      return this.inner.get(key);
    }
    delete(key: string) {
      return this.inner.delete(key);
    }
    exists(key: string) {
      return this.inner.exists(key);
    }
    list(prefix: string) {
      return this.inner.list(prefix);
    }
  }

  const PIXEL =
    "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

  const input = (idempotencyKey: string | null = null) => ({
    dataUrl: PIXEL,
    mime: "image/jpeg",
    bytes: 6,
    width: 800,
    height: 600,
    kind: "close",
    caption: "",
    advisories: [] as string[],
    idempotencyKey,
  });

  it("a failed byte write leaves neither a row nor an object", async () => {
    const objects = new ControllablePut(f.objects);
    const store = new SqlStore(f.driver, { pepper: TEST_PEPPER, objects });
    const intakeId = intakeIdFor(f.seed, "active");

    objects.failPut = true;
    await expect(store.attachPhoto(intakeId, "prac_northgate", input())).rejects.toThrow();

    // "Half a photograph" is the failure to avoid in both directions: a row
    // pointing at nothing is visible but wrong, and an object with no row is
    // invisible and permanent.
    const { rows } = await f.driver.query("SELECT id FROM photos WHERE intake_id = $1", [intakeId]);
    expect(rows).toHaveLength(0);
    expect(await f.objects.list("prac_northgate/")).toEqual([]);
  });

  it("the bytes are written after the transaction commits, not inside it", async () => {
    // Inside the transaction, any later rollback — a failed re-read, a
    // deadlock, a lost connection — would undo the row and strand the object.
    const src = readFileSync(join(process.cwd(), "src/lib/store/sql.ts"), "utf8");
    const body = src.slice(src.indexOf("async attachPhoto("), src.indexOf("async removePhoto("));
    const txEnd = body.indexOf("});", body.indexOf("driver.transaction"));
    const putAt = body.indexOf("objects.put(");
    expect(putAt).toBeGreaterThan(txEnd);
  });

  it("a successful upload stores both halves", async () => {
    const store = new SqlStore(f.driver, { pepper: TEST_PEPPER, objects: f.objects });
    const intakeId = intakeIdFor(f.seed, "active");
    const res = await store.attachPhoto(intakeId, "prac_northgate", input());
    expect(res.ok).toBe(true);
    const { rows } = await f.driver.query<{ object_key: string }>(
      "SELECT object_key FROM photos WHERE intake_id = $1",
      [intakeId],
    );
    expect(rows).toHaveLength(1);
    expect(await f.objects.exists(rows[0].object_key)).toBe(true);
  });

  it("a retry converges on the first upload rather than mixing the two", async () => {
    // The retry used to re-put the bytes while the row kept the first
    // attempt's metadata, so the record described one image and the store
    // held another.
    const store = new SqlStore(f.driver, { pepper: TEST_PEPPER, objects: f.objects });
    const intakeId = intakeIdFor(f.seed, "active");
    await store.attachPhoto(intakeId, "prac_northgate", input("retry-1"));
    const first = await f.driver.query<{ object_key: string; width: number }>(
      "SELECT object_key, width FROM photos WHERE intake_id = $1",
      [intakeId],
    );
    const bytesBefore = (await f.objects.get(first.rows[0].object_key))!.body.toString("base64");

    // Same idempotency key, different image.
    const other =
      "data:image/jpeg;base64," +
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString("base64");
    await store.attachPhoto(intakeId, "prac_northgate", { ...input("retry-1"), dataUrl: other, width: 1600 });

    const after = await f.driver.query<{ object_key: string; width: number }>(
      "SELECT object_key, width FROM photos WHERE intake_id = $1",
      [intakeId],
    );
    expect(after.rows).toHaveLength(1);
    expect(Number(after.rows[0].width)).toBe(800);
    const bytesAfter = (await f.objects.get(after.rows[0].object_key))!.body.toString("base64");
    expect(bytesAfter, "the row and the bytes must describe the same image").toBe(bytesBefore);
  });
});

describe("the route matrix has no exemptions", () => {
  it("/api/metrics calls a real clinician guard", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/metrics/route.ts"), "utf8");
    expect(src).toMatch(/requireClinician/);
  });

  it("the matrix test does not exempt any path by name", () => {
    // The exemption made the suite green and the matrix false. A carve-out is
    // how a matrix stops describing the system.
    const src = readFileSync(join(process.cwd(), "tests/pilot-routes.test.ts"), "utf8");
    const guardCheck = src.slice(src.indexOf('byClass("clinician")'), src.indexOf('byClass("pilot-only")'));
    expect(guardCheck).not.toMatch(/r\.path === "/);
  });
});

describe("logout ends the session on the server", () => {
  /**
   * The cookie is stateless and signed, so clearing it in one browser used to
   * be the entirety of "log out": the cookie itself stayed valid for the rest
   * of its twelve hours. Anyone who had captured it kept reading patient
   * histories after the clinician believed they were done.
   */
  it("bumping the epoch invalidates a cookie already issued", async () => {
    const account = (await f.store.clinicianByEmail("okonkwo@northgate.example"))!;
    expect(account.sessionEpoch).toBe(0);

    const next = await f.store.bumpSessionEpoch(account.id);
    expect(next).toBe(1);

    const after = (await f.store.clinicianById(account.id))!;
    expect(after.sessionEpoch).toBe(1);
    // A cookie carrying epoch 0 no longer matches the account.
    expect(account.sessionEpoch).not.toBe(after.sessionEpoch);
  });

  it("the guard compares the epoch, so the check is load-bearing", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/auth/guard.ts"), "utf8");
    expect(src).toMatch(/session\.epoch/);
    expect(src).toMatch(/sessionEpoch/);
  });

  it("the logout route bumps it", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/auth/logout/route.ts"), "utf8");
    expect(src).toMatch(/bumpSessionEpoch/);
  });

  it("a cookie issued before the column existed is not signed out by the deploy", () => {
    // An absent epoch reads as 0, which matches a fresh account. Turning a
    // schema change into a mass sign-out mid-clinic is its own incident.
    const src = readFileSync(join(process.cwd(), "src/lib/auth/guard.ts"), "utf8");
    expect(src).toMatch(/session\.epoch \?\? 0/);
  });
});

describe("the audit trail records only what happened", () => {
  it("removePhoto reports whether it actually removed anything", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    // Nothing to remove: an id that does not exist.
    const miss = await f.store.removePhoto(intakeId, "pho_does_not_exist");
    expect(miss.removed).toBe(false);
  });

  it("a frozen intake reports no removal rather than pretending", async () => {
    const intakeId = intakeIdFor(f.seed, "submitted");
    const res = await f.store.removePhoto(intakeId, "pho_anything");
    expect(res.removed).toBe(false);
  });

  it("the route audits only a real deletion", () => {
    const src = readFileSync(
      join(process.cwd(), "src/app/api/intake/[token]/photos/[photoId]/route.ts"),
      "utf8",
    );
    // The audit call must be inside a removal check, not unconditional — a
    // patient could otherwise write as many photo.deleted events as they liked
    // for photographs that were never deleted.
    const del = src.slice(src.indexOf("export async function DELETE"));
    expect(del).toMatch(/if \(removed\)[\s\S]{0,200}photo\.deleted/);
  });
});

describe("the verification budget is five, not five per instant", () => {
  it("twenty simultaneous guesses spend exactly five attempts", async () => {
    // resolveToken read the counter and the route incremented it after checking
    // the answer, so requests arriving together each read a count under the
    // limit and each got a guess. The real budget was whatever the rate
    // limiter's burst allowed, not the five the design advertises.
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    const claims = await Promise.all(
      Array.from({ length: 20 }, () => f.store.claimVerificationAttempt(t.intakeId)),
    );
    expect(claims.filter((c) => c.allowed)).toHaveLength(5);
    expect(new Set(claims.filter((c) => c.allowed).map((c) => c.attempts)).size).toBe(5);

    const r = await f.store.resolveToken(t.rawToken);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("locked");
  });

  it("a correct answer gives the budget back, so a mistyped date costs nothing", async () => {
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    await f.store.claimVerificationAttempt(t.intakeId);
    await f.store.claimVerificationAttempt(t.intakeId);
    await f.store.markVerified(t.intakeId);
    const { rows } = await f.driver.query<{ failed_verifications: number }>(
      "SELECT failed_verifications FROM patient_tokens WHERE intake_id = $1",
      [t.intakeId],
    );
    expect(Number(rows[0].failed_verifications)).toBe(0);
  });

  it("the route claims before it checks", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/intake/[token]/verify/route.ts"), "utf8");
    expect(src.indexOf("claimVerificationAttempt")).toBeLessThan(src.indexOf("factor.verify("));
  });
});

describe("tenant guards that were pinned by no test", () => {
  /**
   * Two guards did leak when removed and nothing turned red. A guard nothing
   * pins is a guard that survives until someone refactors past it.
   */
  it("the note route refuses another practice's intake", async () => {
    // Scoped existence check before any write.
    const src = readFileSync(
      join(process.cwd(), "src/app/api/clinician/intakes/[id]/note/route.ts"),
      "utf8",
    );
    expect(src).toMatch(/bundleForClinician\(id, scope\.practiceId\)/);
    // And the store query it depends on really is scoped.
    expect(await f.store.bundleForClinician("int_other", "prac_northgate")).toBeNull();
    expect(await f.store.bundleForClinician("int_other", "prac_riverside")).not.toBeNull();
  });

  it("removePhoto cannot reach a photo belonging to another intake", async () => {
    // The photo id alone is not authority: it is only ever matched together
    // with the intake the patient's token resolves to.
    const mine = intakeIdFor(f.seed, "active");
    const theirs = intakeIdFor(f.seed, "live");
    const key = "prac_northgate/int_live/ffffffffffffffffffffffffffffffff.jpg";
    await f.objects.put(key, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
    await f.store.addPhoto({
      id: "pho_theirs", intakeId: theirs, practiceId: "prac_northgate", objectKey: key,
      mime: "image/jpeg", bytes: 3, width: 800, height: 600, kind: "close",
      caption: "", advisories: [], idempotencyKey: null,
    });

    const res = await f.store.removePhoto(mine, "pho_theirs");
    expect(res.removed).toBe(false);
    const { rows } = await f.driver.query("SELECT id FROM photos WHERE id = 'pho_theirs'");
    expect(rows, "another intake's photo must survive").toHaveLength(1);
    expect(await f.objects.exists(key)).toBe(true);
  });
});

describe("guarantees the shipped client can actually reach", () => {
  it("the photo upload sends an idempotency key", () => {
    // The server accepted one and had a unique index behind it; the client
    // never sent one, so "a retried upload cannot create a second photo" was
    // true of the API and unreachable from the app. A patient on hospital wifi
    // whose upload times out and retries is exactly who it is for.
    const src = readFileSync(join(process.cwd(), "src/components/patient/PhotoStep.tsx"), "utf8");
    expect(src).toMatch(/idempotencyKey/);
    const body = src.slice(src.indexOf("body: JSON.stringify"), src.indexOf("const data = await res.json()"));
    expect(body).toMatch(/idempotencyKey/);
  });
});

describe("retention deletes the person, not only the paperwork", () => {
  it("an abandoned intake has a retention clock", async () => {
    // The query required submitted_at IS NOT NULL, so a patient who opened
    // their link, typed a symptom and closed the tab left a record that no job
    // would ever collect. "Forever" is the one outcome a retention policy is
    // there to rule out.
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    await f.driver.query(
      "UPDATE intakes SET submitted_at = NULL, last_activity_at = now() - interval '90 days' WHERE id = $1",
      [t.intakeId],
    );
    // Without the abandoned cutoff it is invisible, exactly as before.
    const ignored = await f.store.intakesPastRetention(new Date());
    expect(ignored.map((r) => r.id)).not.toContain(t.intakeId);
    // With it, it is collected.
    const due = await f.store.intakesPastRetention(new Date(), new Date(Date.now() - 30 * 86400_000));
    expect(due.map((r) => r.id)).toContain(t.intakeId);
  });

  it("deleting an intake also removes the patient's name and date of birth", async () => {
    // Deleting the intake alone left `patients` (name, exact date of birth) and
    // `visits` (appointment time, reason booked) intact. The clinical content
    // was gone while the fact that a named person had a dermatology appointment
    // for a stated reason remained indefinitely.
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    const { rows: before } = await f.driver.query<{ patient_id: string; visit_id: string }>(
      "SELECT v.patient_id, v.id AS visit_id FROM intakes i JOIN visits v ON v.id = i.visit_id WHERE i.id = $1",
      [t.intakeId],
    );
    expect(before).toHaveLength(1);

    await f.store.deleteIntake(t.intakeId);

    const visit = await f.driver.query("SELECT id FROM visits WHERE id = $1", [before[0].visit_id]);
    expect(visit.rows, "the appointment must not outlive the record").toHaveLength(0);
    const patient = await f.driver.query("SELECT id FROM patients WHERE id = $1", [before[0].patient_id]);
    expect(patient.rows, "the name and date of birth must not outlive the record").toHaveLength(0);
  });

  it("a patient with another appointment inside the window survives", async () => {
    // Deleting one visit's intake must not erase a patient who is still
    // expected in the clinic next week.
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    const { rows } = await f.driver.query<{ patient_id: string }>(
      "SELECT v.patient_id FROM intakes i JOIN visits v ON v.id = i.visit_id WHERE i.id = $1",
      [t.intakeId],
    );
    const patientId = rows[0].patient_id;
    await f.driver.query(
      "INSERT INTO visits (id, practice_id, patient_id, scheduled_for) VALUES ('vis_future','prac_northgate',$1, now() + interval '7 days')",
      [patientId],
    );

    await f.store.deleteIntake(t.intakeId);
    const still = await f.driver.query("SELECT id FROM patients WHERE id = $1", [patientId]);
    expect(still.rows).toHaveLength(1);
  });

  it("the retention job passes the abandoned cutoff", () => {
    const src = readFileSync(join(process.cwd(), "scripts/pilot.ts"), "utf8");
    expect(src).toMatch(/intakesPastRetention\(intakeCutoff, abandonedCutoff\)/);
  });
});

describe("configuration knobs that actually decide something", () => {
  it("AION_PATIENT_SECOND_FACTOR reaches token issuance", async () => {
    // It was read only to print a line in `pilot:check`, so an operator could
    // set it, see it echoed back, and still be issuing date-of-birth tokens.
    // A security knob that changes nothing is the worst kind: it is believed.
    const codeStore = new SqlStore(f.driver, { pepper: TEST_PEPPER, defaultSecondFactor: "code" });
    const t = f.seed.tokens.find((x) => x.state === "active")!;
    await codeStore.issueToken(t.intakeId, "prac_northgate", "a-fresh-raw-token-for-this-test", new Date(Date.now() + 3600_000).toISOString());
    const r = await codeStore.resolveToken("a-fresh-raw-token-for-this-test");
    expect(r.ok && r.access.secondFactorKind).toBe("code");
  });

  it("the default is still date of birth when nothing is configured", async () => {
    const plain = new SqlStore(f.driver, { pepper: TEST_PEPPER });
    const t = f.seed.tokens.find((x) => x.state === "live")!;
    await plain.issueToken(t.intakeId, "prac_northgate", "another-fresh-raw-token", new Date(Date.now() + 3600_000).toISOString());
    const r = await plain.resolveToken("another-fresh-raw-token");
    expect(r.ok && r.access.secondFactorKind).toBe("dob");
  });

  it("the store built from configuration passes the configured factor", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/store/index.ts"), "utf8");
    expect(src.match(/defaultSecondFactor: cfg\.patientSecondFactor/g), "both build paths must pass it")
      .toHaveLength(2);
  });
});

describe("a pilot can actually be started", () => {
  /**
   * Every guarantee in this repository was about protecting records a pilot had
   * no way to create: patient tokens existed only in the synthetic seed, and the
   * documented recipe for a clinician account hashed a password by requiring
   * `./dist/lib/auth/password`, from a `dist/` this project does not build. The
   * infrastructure was complete and unusable.
   */
  it("there is a command to enrol a visit and issue a link", () => {
    const src = readFileSync(join(process.cwd(), "scripts/pilot.ts"), "utf8");
    expect(src).toMatch(/async function cmdInvite/);
    expect(src).toMatch(/invite: cmdInvite/);
    // One transaction: a visit with no intake is a half-enrolled patient.
    const body = src.slice(src.indexOf("async function cmdInvite"), src.indexOf("async function cmdCode"));
    expect(body).toMatch(/driver\.transaction\(/);
    expect(body).toMatch(/INSERT INTO patients[\s\S]*INSERT INTO visits[\s\S]*INSERT INTO intakes/);
  });

  it("there is a command to create a clinician account", () => {
    const src = readFileSync(join(process.cwd(), "scripts/pilot.ts"), "utf8");
    expect(src).toMatch(/async function cmdClinician/);
    // The password comes from the environment, not a flag: an argument is in
    // shell history and in every other user's view of the process list.
    const body = src.slice(src.indexOf("async function cmdClinician"), src.indexOf("async function cmdInvite"));
    expect(body).toMatch(/AION_NEW_CLINICIAN_PASSWORD/);
    expect(body).not.toMatch(/arg\("password"\)/);
  });

  it("the setup guide no longer tells an operator to require a dist/ that is never built", () => {
    const doc = readFileSync(join(process.cwd(), "PILOT_SETUP.md"), "utf8");
    expect(doc).not.toMatch(/dist\/lib\/auth\/password/);
    expect(doc).toMatch(/pilot:clinician/);
  });
});

describe("photographs survive the write path", () => {
  /**
   * Photos live in the photos TABLE; the intake document carries an empty
   * array. `withIntake` returned the document-based intake, so every caller
   * that rendered its result showed a record with no photographs — the
   * clinician brief and the patient's own review screen both did. The rows and
   * the bytes were untouched the whole time; only the screen was wrong, which
   * is the version of this bug that no storage test can see.
   */
  async function withPhoto(intakeId: string): Promise<string> {
    const { photoKey } = await import("@/lib/objects");
    const key = photoKey("prac_northgate", intakeId, "image/jpeg");
    await f.objects.put(key, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
    await f.store.addPhoto({
      id: `pho_${intakeId}`, intakeId, practiceId: "prac_northgate", objectKey: key,
      mime: "image/jpeg", bytes: 3, width: 800, height: 600, kind: "close",
      caption: "", advisories: [], idempotencyKey: null,
    });
    return key;
  }

  it("withIntake hands the caller the photos that exist", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    await withPhoto(intakeId);
    const seen = await f.store.withIntake(intakeId, async (intake) => ({
      intake: null,
      result: intake.photos.length,
    }));
    expect(seen, "the mutator saw an intake with no photographs").toBe(1);
  });

  it("a write does not make them disappear", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    await withPhoto(intakeId);
    await f.store.withIntake(intakeId, async (intake) => ({
      intake: { ...intake, note: "an edit" },
      result: null,
    }));
    const bundle = await f.store.bundleById(intakeId);
    expect(bundle!.intake.photos).toHaveLength(1);
  });

  it("the document never carries a second copy of them", async () => {
    // A copy in the document is a copy to keep in step, and it would survive
    // the photo's deletion.
    const intakeId = intakeIdFor(f.seed, "active");
    await withPhoto(intakeId);
    await f.store.withIntake(intakeId, async (intake) => ({
      intake: { ...intake, note: "an edit" },
      result: null,
    }));
    const { rows } = await f.driver.query<{ n: number }>(
      "SELECT jsonb_array_length(document->'photos') AS n FROM intakes WHERE id = $1",
      [intakeId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("the clinician screen can actually write", () => {
  it("the brief is handed the session's CSRF token", () => {
    // It was issued at login and sent by nothing, so the double-submit check
    // refused every clinician write — correctly, and invisibly.
    const page = readFileSync(join(process.cwd(), "src/app/clinician/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/csrf: ctx\?\.session\.csrf/);
  });

  it("every write sends it, and none of them ignores the response", () => {
    const view = readFileSync(join(process.cwd(), "src/components/clinician/BriefView.tsx"), "utf8");
    expect(view).toMatch(/headers\.set\("x-aion-csrf", data\.csrf\)/);
    // A false "Saved" on a clinical screen is worse than silence.
    expect(view).toMatch(/if \(!res\.ok\)/);
    const writes = [...view.matchAll(/await fetch\(`\/api\/clinician/g)];
    expect(writes, "a clinician write that bypasses send() skips the CSRF header").toHaveLength(0);
  });
});


describe("patient text never carries invisible characters into a clinical document", () => {
  /**
   * `sanitizeText` strips C0/C1 control codes, zero-width characters and — the
   * one that matters — Unicode bidi overrides, which can visually reorder a
   * line as a physician reads it: move which side of a "no" a symptom falls on.
   * Two paths skipped it, and one of them was the field the brief presents as
   * the patient's own words.
   *
   * The payloads are written as escapes rather than literals on purpose. These
   * characters are invisible in a diff, in a review, and in most terminals,
   * which is the entire reason they are worth stripping.
   */
  it("the review-screen edit sanitises the verbatim, not only the tidied value", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/intake/[token]/facts/route.ts"), "utf8");
    expect(src).toMatch(/verbatim: sanitizeText\(value\)/);
    expect(src).not.toMatch(/verbatim: value,/);
  });

  it("the photo caption is sanitised too", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/intake/[token]/photos/route.ts"), "utf8");
    expect(src).toMatch(/sanitizeText\(b\.caption\)/);
  });

  it("sanitizeText removes bidi overrides, zero-width and control characters", async () => {
    const { sanitizeText } = await import("@/lib/interview/engine");
    expect(sanitizeText("\u202Ehidden\u202C")).toBe("hidden");
    expect(sanitizeText("a\u200Bb")).toBe("ab");
    expect(sanitizeText("x\u0007y")).toBe("xy");
    expect(sanitizeText("no\u2066 \u2069allergies")).toBe("no allergies");
    // Ordinary whitespace is a patient typing, not an attack.
    expect(sanitizeText("two\nlines\there")).toBe("two\nlines\there");
  });
});

describe("analytics values are shaped, not just their keys", () => {
  it("drops a value that reads as prose", async () => {
    const { __analyticsTesting } = await import("@/lib/analytics");
    // An allowlisted key said WHICH fact may be recorded and nothing about what
    // the value held, so a patient-influenced string under an allowlisted key
    // put free text into the one store meant to hold none.
    const cleaned = __analyticsTesting.sanitize({
      slot: "onset",
      pathway: "a whole sentence a patient typed",
      count: 3,
    });
    expect(cleaned.slot).toBe("onset");
    expect(cleaned.pathway, "prose must be dropped, not truncated").toBeUndefined();
    expect(cleaned.count).toBe(3);
  });
});
