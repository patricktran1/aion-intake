import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pgliteDriver } from "@/lib/db/pglite";
import { migrate } from "@/lib/db/migrate";
import { seedPilot, SEED_PASSWORD, type PilotSeed } from "@/lib/db/seed-pilot";
import { SqlStore } from "@/lib/store/sql";
import { LocalObjectStore } from "@/lib/objects/local";
import { setStore } from "@/lib/store";
import { setObjectStore } from "@/lib/objects/select";
import { resetConfigCache } from "@/lib/config/runtime";
import { resetRateLimits } from "@/lib/ratelimit";
import { issueSession } from "@/lib/auth/session";
import { dumpDatabase, restoreDatabase } from "@/lib/db/backup";
import { verifyPassword } from "@/lib/auth/password";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "@/lib/db/driver";
import { jpegDataUrl } from "./fixtures/images";

/**
 * The full synthetic pilot rehearsal, from an empty database.
 *
 * One test, in order, mirroring the steps an operator would take before the
 * first real patient: migrate → seed → clinician login → patient verify →
 * intake → photo → review → submit → brief → note → audit → retention dry
 * run → revoke → delete → prove inaccessible → backup → restore → cross-tenant
 * attack. If any link in that chain is broken this fails, which is the point:
 * the pieces are tested in isolation elsewhere, and this proves they compose.
 */

const PEPPER = "rehearsal-pepper-".padEnd(48, "z");
const SECRET = "rehearsal-session-secret-".padEnd(48, "q");

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => cookieValue }) }));
let cookieValue: { value: string } | undefined;

let driver: Driver;
let store: SqlStore;
let objects: LocalObjectStore;
let seed: PilotSeed;
let objectRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const [k, v] of Object.entries({
    AION_RUNTIME_MODE: "pilot",
    DATABASE_URL: "postgres://test/test",
    AION_SESSION_SECRET: SECRET,
    AION_TOKEN_PEPPER: PEPPER,
    AION_OBJECT_STORE: "local",
    AION_OBJECT_STORE_ROOT: "/tmp/aion-rehearsal",
    AION_PHOTO_RETENTION_DAYS: "30",
    AION_INTAKE_RETENTION_DAYS: "90",
  })) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  resetConfigCache();

  // Step 1-2: a completely empty database, migrated from zero.
  driver = await pgliteDriver();
  await migrate(driver);
  objectRoot = await mkdtemp(join(tmpdir(), "aion-rehearsal-"));
  objects = new LocalObjectStore(objectRoot);
  store = new SqlStore(driver, { pepper: PEPPER, objects });
  setStore(store);
  setObjectStore(objects);
  // Step 4: seed two practices.
  seed = await seedPilot(driver, PEPPER);
  resetRateLimits();
}, 60_000);

afterAll(async () => {
  await driver.close();
  await rm(objectRoot, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
  setStore(null);
  setObjectStore(null);
});

const jsonReq = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Request(`http://aion.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "aion.test", ...headers },
    body: JSON.stringify(body),
  });
const tok = (label: string) => seed.tokens.find((t) => t.label === label)!;

describe("full synthetic pilot rehearsal from zero", () => {
  it("runs the entire lifecycle in order", async () => {
    const live = tok("live");

    // Step 5: clinician login.
    const account = await store.clinicianByEmail("okonkwo@northgate.example");
    expect(account).not.toBeNull();
    expect(await verifyPassword(SEED_PASSWORD, account!.passwordHash)).toBe(true);
    const { value } = issueSession(account!.id, account!.practiceId, SECRET);
    cookieValue = { value };

    // Step 6: patient verification (right DOB — Daniel Whitaker).
    const { POST: verify } = await import("@/app/api/intake/[token]/verify/route");
    const badVerify = await verify(jsonReq("/x", { dateOfBirth: "2000-01-01" }), {
      params: Promise.resolve({ token: live.rawToken }),
    });
    expect(badVerify.status).toBe(401);
    const goodVerify = await verify(jsonReq("/x", { dateOfBirth: "2007-02-18" }), {
      params: Promise.resolve({ token: live.rawToken }),
    });
    expect(goodVerify.status).toBe(200);

    // Step 7: patient intake.
    const { POST: start } = await import("@/app/api/intake/[token]/start/route");
    const { POST: message } = await import("@/app/api/intake/[token]/message/route");
    expect((await start(jsonReq("/x"), { params: Promise.resolve({ token: live.rawToken }) })).status).toBe(200);
    for (const text of ["Breaking out on my jaw and it scars", "Two years, worse lately", "A wash that dried me out"]) {
      const r = await message(jsonReq("/x", { answer: text, inputMode: "text" }), {
        params: Promise.resolve({ token: live.rawToken }),
      });
      expect(r.status).toBe(200);
    }

    // Step 8: photo upload → object storage + photos table.
    const { POST: photo } = await import("@/app/api/intake/[token]/photos/route");
    const up = await photo(jsonReq("/x", { dataUrl: jpegDataUrl(1200, 1600), kind: "close" }), {
      params: Promise.resolve({ token: live.rawToken }),
    });
    expect(up.status).toBe(200);
    const { rows: photoRows } = await driver.query<{ id: string; object_key: string }>(
      "SELECT id, object_key FROM photos WHERE intake_id = $1",
      [live.intakeId],
    );
    expect(photoRows).toHaveLength(1);
    expect(await objects.exists(photoRows[0].object_key)).toBe(true);

    // Step 9: patient review/correction.
    const { PATCH: facts } = await import("@/app/api/intake/[token]/facts/route");
    const edit = await facts(
      new Request("http://aion.test/x", {
        method: "PATCH",
        headers: { "content-type": "application/json", host: "aion.test" },
        body: JSON.stringify({ slot: "goal", value: "Stop the scarring" }),
      }),
      { params: Promise.resolve({ token: live.rawToken }) },
    );
    expect(edit.status).toBe(200);

    // Step 10: submission.
    const { POST: submit } = await import("@/app/api/intake/[token]/submit/route");
    expect((await submit(jsonReq("/x"), { params: Promise.resolve({ token: live.rawToken }) })).status).toBe(200);
    const submitted = await store.getIntake(live.intakeId);
    expect(submitted!.status).toBe("ready_for_review");
    expect(submitted!.hpi).toBeTruthy();

    // Step 11: clinician brief — the patient's words reach the clinician's list.
    const { GET: list } = await import("@/app/api/clinician/intakes/route");
    const listRes = await list(new Request("http://aion.test/api/clinician/intakes", { headers: { host: "aion.test" } }));
    const { intakes } = await listRes.json();
    expect(intakes.some((i: { id: string }) => i.id === live.intakeId)).toBe(true);

    // Step 12-13: clinician edit + note.
    const { PATCH: review } = await import("@/app/api/clinician/intakes/[id]/route");
    const { session } = issueSession(account!.id, account!.practiceId, SECRET);
    cookieValue = { value: issueSession(account!.id, account!.practiceId, SECRET).value };
    // Re-issue and capture csrf for the write.
    const issued = issueSession(account!.id, account!.practiceId, SECRET);
    cookieValue = { value: issued.value };
    const editRes = await review(
      new Request(`http://aion.test/api/clinician/intakes/${live.intakeId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          host: "aion.test",
          origin: "http://aion.test",
          "x-aion-csrf": issued.session.csrf,
        },
        body: JSON.stringify({ review: { assessment: "Acne with scarring" } }),
      }),
      { params: Promise.resolve({ id: live.intakeId }) },
    );
    expect(editRes.status).toBe(200);
    void session;

    // Step 14: audit inspection — actions recorded, no clinical content.
    const audit = await store.readAudit({ intakeId: live.intakeId });
    expect(audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(["intake.verified", "intake.submitted", "photo.uploaded"]),
    );
    expect(JSON.stringify(audit)).not.toContain("scarring");
    expect(JSON.stringify(audit)).not.toContain(live.rawToken);

    // Step 15: retention dry run finds nothing yet (submitted 0 days ago).
    expect(await store.intakesPastRetention(new Date(Date.now() - 86400_000))).toEqual([]);

    // Step 16: revoke a different token; it stops resolving immediately.
    const active = tok("active");
    await store.revokeToken(active.intakeId);
    expect(await store.resolveToken(active.rawToken)).toEqual({ ok: false, reason: "revoked" });

    // Step 17-18: delete the submitted intake; prove it and its photo are gone.
    const del = await store.deleteIntake(live.intakeId);
    expect(del.deleted).toBe(true);
    for (const key of del.photoKeys) await objects.delete(key);
    expect(await store.getIntake(live.intakeId)).toBeNull();
    expect(await store.resolveToken(live.rawToken)).toEqual({ ok: false, reason: "not_found" });
    expect(await objects.exists(photoRows[0].object_key)).toBe(false);
    // The audit trail survives its subject.
    expect((await store.readAudit({ intakeId: live.intakeId })).length).toBeGreaterThan(0);

    // Step 19-20: backup and restore round-trips what remains.
    const backup = await dumpDatabase(driver, new Date().toISOString());
    await driver.query("DELETE FROM intakes");
    expect((await driver.query("SELECT id FROM intakes")).rows.length).toBe(0);
    await restoreDatabase(driver, backup);
    expect((await driver.query("SELECT id FROM intakes")).rows.length).toBeGreaterThan(0);

    // Step 21: cross-tenant attack — Northgate clinician cannot see Riverside.
    const riverside = tok("other");
    expect(await store.bundleForClinician(riverside.intakeId, "prac_northgate")).toBeNull();
    expect(await store.bundleForClinician(riverside.intakeId, "prac_riverside")).not.toBeNull();
  }, 60_000);
});
