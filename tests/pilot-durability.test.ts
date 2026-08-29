import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, intakeIdFor, type PilotFixture } from "./helpers/pilot";
import { migrate, loadMigrations, isUpToDate } from "@/lib/db/migrate";
import { pgliteDriver } from "@/lib/db/pglite";
import { photoKey } from "@/lib/objects";
import { AppError } from "@/lib/errors";

/**
 * Durability, concurrency and lifecycle against real Postgres.
 *
 * The in-memory promise chain that protects the demo disappears the moment
 * there are two web instances. These tests assert the replacement — row locks
 * inside transactions — actually holds, using genuine Postgres semantics
 * rather than a fake that would agree with whatever the code does.
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

describe("migrations", () => {
  it("build the schema from zero and are idempotent", async () => {
    const driver = await pgliteDriver();
    try {
      const first = await migrate(driver);
      expect(first.applied).toEqual(loadMigrations().map((m) => m.name));
      expect(await isUpToDate(driver)).toBe(true);

      const second = await migrate(driver);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied.length).toBe(first.applied.length);

      // Every table the store depends on exists.
      const { rows } = await driver.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
      );
      const names = new Set(rows.map((r) => r.table_name));
      for (const t of ["practices", "clinicians", "patients", "visits", "intakes", "patient_tokens", "photos", "audit_events"]) {
        expect(names.has(t), `missing table ${t}`).toBe(true);
      }
    } finally {
      await driver.close();
    }
  }, 60_000);

  it("refuse to run when an applied migration file has changed", async () => {
    const driver = await pgliteDriver();
    try {
      await migrate(driver);
      await driver.query("UPDATE schema_migrations SET checksum = 'tampered'");
      await expect(migrate(driver)).rejects.toThrow(/has changed since it was applied/);
    } finally {
      await driver.close();
    }
  }, 60_000);
});

describe("atomic intake writes", () => {
  it("concurrent answers all land — no lost update", async () => {
    const id = intakeIdFor(f.seed, "active");
    const append = (text: string) =>
      f.store.withIntake(id, async (intake) => ({
        intake: {
          ...intake,
          questionCount: intake.questionCount + 1,
          messages: [
            ...intake.messages,
            { id: `m_${text}`, role: "patient" as const, text, at: new Date().toISOString(), targets: [] },
          ],
        },
        result: text,
      }));

    const before = (await f.store.getIntake(id))!;
    await Promise.all(["a", "b", "c", "d", "e"].map(append));

    const after = (await f.store.getIntake(id))!;
    expect(after.messages.length).toBe(before.messages.length + 5);
    expect(after.questionCount).toBe(before.questionCount + 5);
    // Every append is present exactly once.
    for (const t of ["a", "b", "c", "d", "e"]) {
      expect(after.messages.filter((m) => m.text === t)).toHaveLength(1);
    }
  });

  it("writes to different intakes do not block or cross over", async () => {
    const a = intakeIdFor(f.seed, "active");
    const b = intakeIdFor(f.seed, "submitted");
    const mark = (id: string, tag: string) =>
      f.store.withIntake(id, async (intake) => ({
        intake: { ...intake, note: tag },
        result: tag,
      }));

    await Promise.all([mark(a, "for-a"), mark(b, "for-b")]);
    expect((await f.store.getIntake(a))!.note).toBe("for-a");
    expect((await f.store.getIntake(b))!.note).toBe("for-b");
  });

  it("returning null commits nothing", async () => {
    const id = intakeIdFor(f.seed, "active");
    const before = (await f.store.getIntake(id))!;
    const out = await f.store.withIntake(id, async () => ({ intake: null, result: "read-only" }));
    expect(out).toBe("read-only");
    const after = (await f.store.getIntake(id))!;
    expect(after.questionCount).toBe(before.questionCount);
    expect(after.messages.length).toBe(before.messages.length);
  });

  it("a throwing mutation rolls back and leaves nothing behind", async () => {
    const id = intakeIdFor(f.seed, "active");
    const before = (await f.store.getIntake(id))!;
    await expect(
      f.store.withIntake(id, async (intake) => {
        void intake;
        throw new Error("mutation blew up");
      }),
    ).rejects.toThrow("mutation blew up");

    const after = (await f.store.getIntake(id))!;
    expect(after.questionCount).toBe(before.questionCount);
    // The lock is released, so the next write still works.
    await f.store.withIntake(id, async (i) => ({ intake: { ...i, note: "after" }, result: null }));
    expect((await f.store.getIntake(id))!.note).toBe("after");
  });

  it("a missing intake is a typed error, not a crash", async () => {
    await expect(f.store.withIntake("int_nope", async (i) => ({ intake: i, result: 1 }))).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("the version column advances on every committed write", async () => {
    const id = intakeIdFor(f.seed, "active");
    const read = async () =>
      Number((await f.driver.query<{ version: number }>("SELECT version FROM intakes WHERE id=$1", [id])).rows[0].version);
    const start = await read();
    await f.store.withIntake(id, async (i) => ({ intake: { ...i, note: "1" }, result: null }));
    await f.store.withIntake(id, async (i) => ({ intake: { ...i, note: "2" }, result: null }));
    expect(await read()).toBe(start + 2);
  });
});

describe("photo idempotency and ownership", () => {
  const add = (id: string, intakeId: string, key: string, idem: string | null) =>
    f.store.addPhoto({
      id, intakeId, practiceId: "prac_northgate", objectKey: key,
      mime: "image/jpeg", bytes: 1000, width: 800, height: 600,
      kind: "close", caption: "", advisories: [], idempotencyKey: idem,
    });

  it("a retried upload does not create a second photo", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const first = await add("pho_a", intakeId, photoKey("prac_northgate", intakeId, "image/jpeg"), "retry-1");
    const second = await add("pho_b", intakeId, photoKey("prac_northgate", intakeId, "image/jpeg"), "retry-1");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await f.store.photoCount(intakeId)).toBe(1);
  });

  it("distinct uploads with distinct keys both land", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    await add("pho_1", intakeId, photoKey("prac_northgate", intakeId, "image/jpeg"), "k1");
    await add("pho_2", intakeId, photoKey("prac_northgate", intakeId, "image/jpeg"), "k2");
    expect(await f.store.photoCount(intakeId)).toBe(2);
  });

  it("concurrent retries of the same upload still produce one photo", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = photoKey("prac_northgate", intakeId, "image/jpeg");
    const results = await Promise.all([
      add("pho_x1", intakeId, key, "same"),
      add("pho_x2", intakeId, `${key}b`, "same"),
      add("pho_x3", intakeId, `${key}c`, "same"),
    ]);
    expect(await f.store.photoCount(intakeId)).toBe(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });
});

describe("deletion and retention", () => {
  it("deleting an intake removes every child and reports the object keys", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = photoKey("prac_northgate", intakeId, "image/jpeg");
    await f.store.addPhoto({
      id: "pho_del", intakeId, practiceId: "prac_northgate", objectKey: key,
      mime: "image/jpeg", bytes: 10, width: 800, height: 600, kind: "close",
      caption: "", advisories: [], idempotencyKey: null,
    });
    await f.objects.put(key, Buffer.from("bytes"), "image/jpeg");

    const res = await f.store.deleteIntake(intakeId);
    expect(res.deleted).toBe(true);
    expect(res.photoKeys).toEqual([key]);

    // Nothing orphaned in any child table.
    for (const [table, column] of [
      ["photos", "intake_id"],
      ["patient_tokens", "intake_id"],
    ] as const) {
      const { rows } = await f.driver.query<{ n: string }>(
        `SELECT count(*)::text n FROM ${table} WHERE ${column} = $1`,
        [intakeId],
      );
      expect(Number(rows[0].n), `${table} left an orphan`).toBe(0);
    }
    expect(await f.store.getIntake(intakeId)).toBeNull();

    // The caller reconciles object storage using the returned keys.
    for (const k of res.photoKeys) await f.objects.delete(k);
    expect(await f.objects.exists(key)).toBe(false);
  });

  it("deleting a missing intake is a no-op, not an error", async () => {
    expect(await f.store.deleteIntake("int_nope")).toEqual({ deleted: false, photoKeys: [] });
  });

  it("audit events survive the deletion of their subject", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    await f.store.appendAudit({
      action: "intake.submitted", actorKind: "patient", actorId: intakeId,
      practiceId: "prac_northgate", resource: "intake", resourceId: intakeId,
      requestId: "req_1", meta: { question_count: 7 },
    });
    await f.store.deleteIntake(intakeId);

    const rows = await f.store.readAudit({ intakeId });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].action).toBe("intake.submitted");
    // The record is gone; the fact that it existed and was submitted is not.
    expect(await f.store.getIntake(intakeId)).toBeNull();
  });

  it("finds records past their retention window and nothing before it", async () => {
    // The submitted intake was submitted half an hour ago.
    const soon = new Date(Date.now() - 60 * 60 * 1000);
    expect((await f.store.intakesPastRetention(soon)).map((r) => r.id)).toEqual([]);

    const later = new Date(Date.now() + 60 * 60 * 1000);
    const ids = (await f.store.intakesPastRetention(later)).map((r) => r.id);
    expect(ids).toContain(intakeIdFor(f.seed, "submitted"));
    // An intake that was never submitted has no retention clock running.
    expect(ids).not.toContain(intakeIdFor(f.seed, "live"));
  });

  it("finds photos past their retention window", async () => {
    const intakeId = intakeIdFor(f.seed, "active");
    const key = photoKey("prac_northgate", intakeId, "image/jpeg");
    await f.store.addPhoto({
      id: "pho_ret", intakeId, practiceId: "prac_northgate", objectKey: key,
      mime: "image/jpeg", bytes: 10, width: 800, height: 600, kind: "close",
      caption: "", advisories: [], idempotencyKey: null,
    });
    expect(await f.store.photosPastRetention(new Date(Date.now() - 3600_000))).toEqual([]);
    const due = await f.store.photosPastRetention(new Date(Date.now() + 3600_000));
    expect(due.map((d) => d.photoId)).toContain("pho_ret");
    expect(due.find((d) => d.photoId === "pho_ret")!.objectKey).toBe(key);
  });
});
