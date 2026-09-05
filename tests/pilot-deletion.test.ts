import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, intakeIdFor, type PilotFixture } from "./helpers/pilot";
import { SqlStore } from "@/lib/store/sql";
import { photoKey } from "@/lib/objects";
import type { ObjectStore, StoredObject } from "@/lib/objects";

/**
 * Deletion under partial failure.
 *
 * Deleting a photograph touches two systems with no transaction between them:
 * a row in Postgres and an object in a bucket. Every ordering has a crash
 * window, and the two windows are not equally bad:
 *
 *   row stranded    — a record pointing at nothing. Visible, recoverable.
 *   OBJECT stranded — a photograph of someone's skin that nothing references,
 *                     nothing lists, and nothing will ever find again. We would
 *                     have reported the deletion as successful.
 *
 * The second is the one that matters, and it is the one this file attacks. The
 * design under test: the row delete and the *intent* to delete the bytes commit
 * in the same transaction, so a crash anywhere leaves a durable claim that the
 * bytes are owed, and a sweeper retries until they are confirmed gone.
 *
 * A reproduction before the outbox existed printed, verbatim:
 *   "ORPHAN CONFIRMED: photograph bytes remain, nothing references them,
 *    nothing will ever reclaim them"
 */

/** An object store that can be told to fail, so partial failure is testable. */
class FlakyObjects implements ObjectStore {
  readonly kind = "local" as const;
  failDeletes = false;
  /** Deletes that threw rather than returned false — the harsher failure. */
  throwOnDelete = false;
  deleteAttempts: string[] = [];

  constructor(private readonly inner: ObjectStore) {}

  put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    return this.inner.put(key, body, contentType);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async delete(key: string): Promise<boolean> {
    this.deleteAttempts.push(key);
    if (this.throwOnDelete) throw new Error("object store unreachable");
    if (this.failDeletes) return false;
    return this.inner.delete(key);
  }
  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }
  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }
}

let f: PilotFixture;
let flaky: FlakyObjects;
/** A store whose object writes go through the flaky wrapper. */
let store: SqlStore;

beforeAll(async () => {
  f = await createPilotFixture();
  flaky = new FlakyObjects(f.objects);
  store = new SqlStore(f.driver, { pepper: "test-pepper-".padEnd(48, "x"), objects: flaky });
}, 60_000);
afterAll(async () => {
  await f.dispose();
});
beforeEach(async () => {
  await f.reseed();
  flaky.failDeletes = false;
  flaky.throwOnDelete = false;
  flaky.deleteAttempts = [];
});

/** Puts a real object and a photo row pointing at it. */
async function givenAPhoto(intakeId: string, id = "pho_del"): Promise<string> {
  const key = photoKey("prac_northgate", intakeId, "image/jpeg");
  await f.objects.put(key, Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
  await store.addPhoto({
    id,
    intakeId,
    practiceId: "prac_northgate",
    objectKey: key,
    mime: "image/jpeg",
    bytes: 3,
    width: 800,
    height: 600,
    kind: "close",
    caption: "",
    advisories: [],
    idempotencyKey: null,
  });
  return key;
}

async function owed(): Promise<string[]> {
  return (await store.pendingObjectDeletions(100)).map((o) => o.objectKey);
}

describe("the four partial-failure orderings", () => {
  it("row deleted + object delete FAILS — the bytes are still owed, and a later sweep gets them", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);

    flaky.failDeletes = true;
    await store.deleteIntake(intakeId);

    // The row is gone and the object is not. Before the outbox, that was the
    // end of the story and the photograph was unreachable forever.
    expect((await f.driver.query("SELECT id FROM photos WHERE object_key = $1", [key])).rows).toHaveLength(0);
    expect(await f.objects.exists(key)).toBe(true);

    // But the intent survived, so the bytes are findable.
    expect(await owed()).toEqual([key]);

    // Storage comes back; the sweeper converges.
    flaky.failDeletes = false;
    expect(await store.sweepPendingDeletions()).toEqual({ swept: 1, failed: 0 });
    expect(await f.objects.exists(key)).toBe(false);
    expect(await owed()).toEqual([]);
  });

  it("row deleted + object delete THROWS — a thrown error is not a resolved deletion", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);

    flaky.throwOnDelete = true;
    // The deletion of the record must still succeed: the patient's data going
    // away cannot be held hostage by a storage outage.
    await expect(store.deleteIntake(intakeId)).resolves.toMatchObject({ deleted: true });
    expect(await owed()).toEqual([key]);
    expect((await store.pendingObjectDeletions(10))[0].attempts).toBe(1);

    flaky.throwOnDelete = false;
    await store.sweepPendingDeletions();
    expect(await f.objects.exists(key)).toBe(false);
  });

  it("object deleted + the row delete never happens — the reverse ordering leaves no orphan", async () => {
    // This is the benign direction, and we assert it stays benign: the object
    // is gone, the row is a dangling reference, and retention still cleans it.
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);
    await f.objects.delete(key);
    expect(await f.objects.exists(key)).toBe(false);

    // The row still exists — a broken photo, not a leaked one.
    expect((await f.driver.query("SELECT id FROM photos WHERE object_key = $1", [key])).rows).toHaveLength(1);

    // Deleting the intake now must not fail on the missing object: "already
    // gone" is the outcome we wanted.
    await store.deleteIntake(intakeId);
    expect(await owed()).toEqual([]);
  });

  it("interrupted between the two operations — a re-run finishes the job", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);

    // Simulate the process dying immediately after the transaction commits: the
    // outbox row exists and no sweep ever ran.
    await f.driver.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO pending_object_deletions (object_key, practice_id, reason)
         VALUES ($1, 'prac_northgate', 'intake_deleted') ON CONFLICT DO NOTHING`,
        [key],
      );
      await tx.query("DELETE FROM intakes WHERE id = $1", [intakeId]);
    });

    // A fresh process starts and reconciles. Nothing carried over in memory.
    const fresh = new SqlStore(f.driver, { pepper: "test-pepper-".padEnd(48, "x"), objects: f.objects });
    expect(await fresh.sweepPendingDeletions()).toEqual({ swept: 1, failed: 0 });
    expect(await f.objects.exists(key)).toBe(false);
  });

  it("retry after a partial deletion is idempotent, not a second failure", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);

    flaky.failDeletes = true;
    await store.deleteIntake(intakeId);
    flaky.failDeletes = false;

    // Three sweeps in a row. The first does the work; the rest find nothing and
    // must not error, and must not re-enqueue anything.
    expect(await store.sweepPendingDeletions()).toEqual({ swept: 1, failed: 0 });
    expect(await store.sweepPendingDeletions()).toEqual({ swept: 0, failed: 0 });
    expect(await store.sweepPendingDeletions()).toEqual({ swept: 0, failed: 0 });
    expect(await owed()).toEqual([]);
  });
});

describe("the sweeper's own failure modes", () => {
  it("a permanently failing key does not starve the queue behind it", async () => {
    // Two owed objects: one the store will never accept, one it will. Ordering
    // by age alone would retry the poison key first and, with a small batch
    // limit, never reach the second.
    const bad = "prac_northgate/int_poison/deadbeefdeadbeefdeadbeefdeadbeef.jpg";
    await f.driver.query(
      "INSERT INTO pending_object_deletions (object_key, practice_id, reason, attempts) VALUES ($1,'prac_northgate','x',9)",
      [bad],
    );
    const good = photoKey("prac_northgate", "int_ok", "image/jpeg");
    await f.objects.put(good, Buffer.from([1]), "image/jpeg");
    await f.driver.query(
      "INSERT INTO pending_object_deletions (object_key, practice_id, reason) VALUES ($1,'prac_northgate','x')",
      [good],
    );

    // A batch of one: the fewest-attempts-first order must pick the fresh key.
    const first = await store.pendingObjectDeletions(1);
    expect(first[0].objectKey).toBe(good);
  });

  it("never resolves an entry it did not confirm gone", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);
    flaky.failDeletes = true;
    await store.deleteIntake(intakeId);

    // Five failed sweeps. The entry must survive every one of them, with a
    // rising attempt count — this is the check that caught a version of
    // sweepOne which ignored the return value and cleared the entry anyway.
    for (let i = 0; i < 5; i += 1) {
      expect(await store.sweepPendingDeletions()).toEqual({ swept: 0, failed: 1 });
    }
    expect(await owed()).toEqual([key]);
    expect((await store.pendingObjectDeletions(10))[0].attempts).toBeGreaterThanOrEqual(5);
    expect(await f.objects.exists(key)).toBe(true);
  });

  it("removing a single photo converges the same way", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);

    flaky.failDeletes = true;
    await store.removePhoto(intakeId, "pho_del");
    expect(await owed()).toEqual([key]);
    expect(await f.objects.exists(key)).toBe(true);

    flaky.failDeletes = false;
    await store.sweepPendingDeletions();
    expect(await f.objects.exists(key)).toBe(false);
  });

  it("two sweepers running at once do not fight", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);
    flaky.failDeletes = true;
    await store.deleteIntake(intakeId);
    flaky.failDeletes = false;

    const both = await Promise.all([store.sweepPendingDeletions(), store.sweepPendingDeletions()]);
    // One of them did the work; neither threw, and the object is gone once.
    expect(both.reduce((n, r) => n + r.swept, 0)).toBeGreaterThanOrEqual(1);
    expect(await f.objects.exists(key)).toBe(false);
    expect(await owed()).toEqual([]);
  });
});

describe("retention is idempotent and safe to interrupt", () => {
  /** The retention job's photo path, as scripts/pilot.ts runs it. */
  async function retirePhotos(cutoff: Date): Promise<number> {
    const due = await store.photosPastRetention(cutoff);
    for (const p of due) await store.retirePhoto(p.photoId);
    return due.length;
  }

  it("one failing object does not abort the rest of the batch", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const keys: string[] = [];
    for (let i = 0; i < 5; i += 1) keys.push(await givenAPhoto(intakeId, `pho_batch_${i}`));

    // Every object delete fails. The old ordering (object first, then row)
    // aborted the loop on the first failure and left four photos undeleted.
    flaky.failDeletes = true;
    const n = await retirePhotos(new Date(Date.now() + 3600_000));
    expect(n).toBe(5);

    // All five rows are gone and all five objects are owed.
    expect((await f.driver.query("SELECT id FROM photos WHERE intake_id = $1", [intakeId])).rows).toHaveLength(0);
    expect((await owed()).sort()).toEqual([...keys].sort());

    flaky.failDeletes = false;
    expect(await store.sweepPendingDeletions()).toEqual({ swept: 5, failed: 0 });
    for (const k of keys) expect(await f.objects.exists(k)).toBe(false);
  });

  it("re-running retention after an interruption deletes nothing twice and misses nothing", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const mine: string[] = [];
    for (let i = 0; i < 4; i += 1) mine.push(await givenAPhoto(intakeId, `pho_rerun_${i}`));
    const cutoff = new Date(Date.now() + 3600_000);

    // Interrupt after two.
    const due = await store.photosPastRetention(cutoff);
    await store.retirePhoto(due[0].photoId);
    await store.retirePhoto(due[1].photoId);

    // Re-run from scratch. The already-retired two are no longer due, so the
    // second run acts on exactly the remaining two.
    const remaining = await store.photosPastRetention(cutoff);
    expect(remaining).toHaveLength(2);
    for (const p of remaining) expect(await store.retirePhoto(p.photoId)).not.toBeNull();

    // A third run finds nothing at all.
    expect(await store.photosPastRetention(cutoff)).toEqual([]);
    expect(await owed()).toEqual([]);
    // Every one of this test's four objects is gone. Scoped to its own keys:
    // the object root outlives a reseed, and earlier tests here deliberately
    // leave un-swept objects behind.
    for (const k of mine) expect(await f.objects.exists(k), k).toBe(false);
  });

  it("retiring a photo id that is already gone is a null, not a crash", async () => {
    expect(await store.retirePhoto("pho_never_existed")).toBeNull();
    const intakeId = intakeIdFor(f.seed, "active");
    await givenAPhoto(intakeId, "pho_twice");
    expect(await store.retirePhoto("pho_twice")).not.toBeNull();
    expect(await store.retirePhoto("pho_twice")).toBeNull();
  });

  it("thousands of expired records delete without unbounded memory or a stuck batch", async () => {
    // Retention at pilot scale is a nightly job over a month of intakes. What
    // this checks is that the work is bounded per batch and converges across
    // batches, not that it is fast.
    const rows: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      const key = `prac_northgate/int_bulk/${i.toString(16).padStart(32, "0")}.jpg`;
      rows.push(key);
    }
    await f.driver.query(
      `INSERT INTO pending_object_deletions (object_key, practice_id, reason)
       SELECT k, 'prac_northgate', 'retention' FROM unnest($1::text[]) AS k`,
      [rows],
    );

    // The batch limit is honoured — an unbounded SELECT would be a memory
    // hazard on a backlog this size.
    expect(await store.pendingObjectDeletions(10_000)).toHaveLength(1000);
    expect(await store.pendingObjectDeletions(200)).toHaveLength(200);

    // Every object is already absent, so each sweep confirms and resolves.
    let guard = 0;
    while ((await store.pendingObjectDeletions(1)).length > 0) {
      await store.sweepPendingDeletions(500);
      guard += 1;
      expect(guard, "sweeper failed to converge").toBeLessThan(10);
    }
    expect(await owed()).toEqual([]);
  }, 120_000);

  it("a deleted intake's photographs are not reachable through any surviving reference", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = await givenAPhoto(intakeId);
    await store.deleteIntake(intakeId);

    // Rows: gone. Bytes: gone. Audit: still there, and it must not carry the
    // object key — an audit row naming the key would be a surviving pointer to
    // a photograph we promised to delete.
    expect(await f.objects.exists(key)).toBe(false);
    expect((await f.driver.query("SELECT id FROM intakes WHERE id = $1", [intakeId])).rows).toHaveLength(0);
    const audit = await store.readAudit({ intakeId, limit: 100 });
    expect(JSON.stringify(audit)).not.toContain(key);
  });
});
