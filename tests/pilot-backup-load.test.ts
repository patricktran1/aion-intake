import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, type PilotFixture } from "./helpers/pilot";
import { dumpDatabase, restoreDatabase } from "@/lib/db/backup";

/**
 * Backup/restore rehearsal and pilot-scale load.
 *
 * TESTED LOCALLY here: that the data round-trips through a logical dump and
 * restore intact, and that the store stays correct under concurrent load.
 * REQUIRES PROVIDER VALIDATION (not tested here): managed Postgres
 * point-in-time recovery, and object-storage versioned restore. See
 * PILOT_SETUP.md — this proves the application's data survives a
 * backup/restore cycle, not that a specific cloud provider's snapshot does.
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

describe("backup and restore round-trips the data", () => {
  it("restores every table after the working data is destroyed", async () => {
    // A patient does real work, so the backup has non-seed content to protect.
    const id = f.seed.tokens.find((t) => t.state === "active")!.intakeId;
    await f.store.withIntake(id, async (intake) => ({
      intake: {
        ...intake,
        note: "clinician scratchpad content",
        messages: [
          ...intake.messages,
          { id: "m1", role: "patient" as const, text: "itchy rash on both arms", at: new Date().toISOString(), targets: [] },
        ],
      },
      result: null,
    }));
    await f.store.appendAudit({
      action: "intake.submitted", actorKind: "patient", actorId: id,
      practiceId: "prac_northgate", resource: "intake", resourceId: id, requestId: "r", meta: { n: 1 },
    });

    const before = {
      practices: (await f.driver.query("SELECT * FROM practices")).rows.length,
      clinicians: (await f.driver.query("SELECT * FROM clinicians")).rows.length,
      intakes: (await f.driver.query("SELECT * FROM intakes")).rows.length,
      tokens: (await f.driver.query("SELECT * FROM patient_tokens")).rows.length,
      audit: (await f.driver.query("SELECT * FROM audit_events")).rows.length,
    };
    expect(before.audit).toBeGreaterThan(0);

    const backup = await dumpDatabase(f.driver, new Date().toISOString());

    // Destroy the working data — the disaster.
    await f.driver.query("DELETE FROM audit_events");
    await f.driver.query("DELETE FROM intakes");
    await f.driver.query("DELETE FROM clinicians");
    await f.driver.query("DELETE FROM practices");
    expect((await f.driver.query("SELECT * FROM intakes")).rows.length).toBe(0);

    await restoreDatabase(f.driver, backup);

    const after = {
      practices: (await f.driver.query("SELECT * FROM practices")).rows.length,
      clinicians: (await f.driver.query("SELECT * FROM clinicians")).rows.length,
      intakes: (await f.driver.query("SELECT * FROM intakes")).rows.length,
      tokens: (await f.driver.query("SELECT * FROM patient_tokens")).rows.length,
      audit: (await f.driver.query("SELECT * FROM audit_events")).rows.length,
    };
    expect(after).toEqual(before);

    // The specific content survived, not just the row counts.
    const restored = await f.store.getIntake(id);
    expect(restored).not.toBeNull();
    expect(restored!.note).toBe("clinician scratchpad content");
    expect(JSON.stringify(restored!.messages)).toContain("itchy rash on both arms");

    // A patient token still resolves after the restore — the hashes came back intact.
    const raw = f.seed.tokens.find((t) => t.state === "active")!.rawToken;
    expect((await f.store.resolveToken(raw)).ok).toBe(true);
  });

  it("a restore is atomic — a failure leaves the database as it was", async () => {
    const backup = await dumpDatabase(f.driver, new Date().toISOString());
    // Corrupt the backup so the restore throws partway.
    backup.tables.intakes.push({ id: "bad", practice_id: "nonexistent_practice" } as Record<string, unknown>);

    const intakesBefore = (await f.driver.query("SELECT id FROM intakes")).rows.length;
    await expect(restoreDatabase(f.driver, backup)).rejects.toThrow();
    // The transaction rolled back: the working data is untouched, not emptied.
    const intakesAfter = (await f.driver.query("SELECT id FROM intakes")).rows.length;
    expect(intakesAfter).toBe(intakesBefore);
  });
});

describe("pilot-scale load stays correct", () => {
  /**
   * PGlite serialises on one connection, so these are NOT latency benchmarks —
   * real numbers need managed Postgres. What they DO find is nonlinear
   * correctness failure under concurrency: lost updates, deadlocks, crashes,
   * cross-linked records. That is the failure the mission asked for.
   */

  async function makeIntakes(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const practiceId = i % 2 === 0 ? "prac_northgate" : "prac_riverside";
      const patientId = i % 2 === 0 ? "pat_ellison" : "pat_dacosta";
      const visitId = `vis_load_${i}`;
      const intakeId = `int_load_${i}`;
      await f.driver.query(
        "INSERT INTO visits (id, practice_id, patient_id, scheduled_for) VALUES ($1,$2,$3, now())",
        [visitId, practiceId, patientId],
      );
      const base = await f.store.getIntake(f.seed.tokens[0].intakeId);
      const blank = {
        ...base!,
        id: intakeId,
        visitId,
        status: "in_progress" as const,
        messages: [],
        facts: [],
        questionCount: 0,
      };
      await f.driver.query(
        `INSERT INTO intakes (id, practice_id, visit_id, status, pathway, urgent_flag, document)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [intakeId, practiceId, visitId, blank.status, blank.pathway, false, JSON.stringify(blank)],
      );
      ids.push(intakeId);
    }
    return ids;
  }

  it("50 patients each answering concurrently lose no writes and cross no records", async () => {
    const ids = await makeIntakes(50);

    // Every patient sends three answers at once — 150 concurrent writes.
    const answerOnce = (id: string, tag: string) =>
      f.store.withIntake(id, async (intake) => ({
        intake: {
          ...intake,
          questionCount: intake.questionCount + 1,
          messages: [
            ...intake.messages,
            { id: `${id}-${tag}`, role: "patient" as const, text: `${id} says ${tag}`, at: new Date().toISOString(), targets: [] },
          ],
        },
        result: null,
      }));

    const started = Date.now();
    const work = ids.flatMap((id) => ["a", "b", "c"].map((tag) => answerOnce(id, tag)));
    const results = await Promise.allSettled(work);
    const elapsed = Date.now() - started;

    // Zero errors under load.
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed, failed.map((r) => (r as PromiseRejectedResult).reason).slice(0, 3).join("; ")).toHaveLength(0);

    // Every intake has exactly its own three messages — none lost, none crossed.
    for (const id of ids) {
      const intake = (await f.store.getIntake(id))!;
      expect(intake.questionCount, `${id} questionCount`).toBe(3);
      const texts = new Set(intake.messages.map((m) => m.text));
      expect(texts).toEqual(new Set([`${id} says a`, `${id} says b`, `${id} says c`]));
    }
    // Every message in a record belongs to that record — the cross-link check.
    // (A substring test would false-positive: "int_load_1" is inside
    // "int_load_10", so compare the message's own id prefix exactly.)
    for (const id of ids) {
      const intake = (await f.store.getIntake(id))!;
      expect(intake.messages.every((m) => m.text.startsWith(`${id} says `))).toBe(true);
    }
    // Informational: throughput on this machine. Not a benchmark.
    expect(elapsed).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("a burst of clinician list reads across two practices never leaks", async () => {
    await makeIntakes(20);
    const reads = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        f.store.listBundles(i % 2 === 0 ? "prac_northgate" : "prac_riverside"),
      ),
    );
    for (let i = 0; i < reads.length; i += 1) {
      const want = i % 2 === 0 ? "prac_northgate" : "prac_riverside";
      expect(reads[i].every((b) => b.practice.id === want)).toBe(true);
    }
  }, 60_000);
});
