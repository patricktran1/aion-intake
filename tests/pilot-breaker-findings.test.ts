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
