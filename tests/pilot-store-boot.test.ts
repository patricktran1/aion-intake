import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "@/lib/config/runtime";
import { setStore, store } from "@/lib/store";
import { migrate } from "@/lib/db/migrate";
import { seedPilot } from "@/lib/db/seed-pilot";

/**
 * The store the APPLICATION builds, not the one the tests build.
 *
 * Every other pilot suite constructs `new SqlStore(pgliteDriver(), ...)`
 * directly. That is the right shape for testing store behaviour and it left a
 * hole exactly the size of `store()` — the factory every route actually calls.
 * Inside it, pilot mode built a `pg` connection pool unconditionally, so the
 * documented local pilot (`npm run dev:pilot`, and the "twenty-second start" in
 * the security review packet) came up with a pool trying to resolve
 * "pglite:.pglite" as a database host. The server started, the pages rendered,
 * and every request that touched data failed. 946 tests were green.
 *
 * So these tests go through `store()` and prove the thing the others assumed:
 * that the configured URL actually reaches a database with data in it.
 */

let dir: string;
const ENV_KEYS = [
  "AION_RUNTIME_MODE",
  "DATABASE_URL",
  "AION_OBJECT_STORE",
  "AION_OBJECT_STORE_ROOT",
  "AION_SESSION_SECRET",
  "AION_TOKEN_PEPPER",
  "AION_PHOTO_RETENTION_DAYS",
  "AION_INTAKE_RETENTION_DAYS",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  dir = await mkdtemp(join(tmpdir(), "aion-boot-"));
  process.env.AION_RUNTIME_MODE = "pilot";
  process.env.DATABASE_URL = `pglite:${join(dir, "db")}`;
  process.env.AION_OBJECT_STORE = "local";
  process.env.AION_OBJECT_STORE_ROOT = join(dir, "objects");
  process.env.AION_SESSION_SECRET = "boot-test-session-secret-".padEnd(48, "a");
  process.env.AION_TOKEN_PEPPER = "boot-test-token-pepper-".padEnd(48, "b");
  process.env.AION_PHOTO_RETENTION_DAYS = "30";
  process.env.AION_INTAKE_RETENTION_DAYS = "90";
  resetConfigCache();
  setStore(null);
});

afterEach(async () => {
  const s = await store().catch(() => null);
  await s?.close().catch(() => {});
  setStore(null);
  resetConfigCache();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

describe("store() in pilot mode against the documented local URL", () => {
  it("reaches a real database — this is the check that was missing", async () => {
    const s = await store();
    expect(s.kind).toBe("sql");
    expect(await s.ping()).toBe(true);
  }, 60_000);

  it("reads back what was seeded, through the same factory the routes use", async () => {
    const s = await store();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driver = (s as any).driver;
    await migrate(driver);
    const seed = await seedPilot(driver, process.env.AION_TOKEN_PEPPER!);

    const t = seed.tokens.find((x) => x.state === "active")!;
    const resolved = await s.resolveToken(t.rawToken);
    expect(resolved.ok).toBe(true);

    const bundle = await s.bundleById(t.intakeId);
    expect(bundle?.intake.id).toBe(t.intakeId);

    // And the tenant boundary still holds through this path.
    expect(await s.bundleForClinician(t.intakeId, "prac_riverside")).toBeNull();
  }, 60_000);

  it("an object store is attached, so photo deletion can actually converge", async () => {
    // buildSqlStore for the pglite branch is a separate code path from the pool
    // branch; forgetting `objects` there would make sweepOne a silent no-op.
    const s = await store();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((s as any).objects).toBeTruthy();
  }, 60_000);
});
