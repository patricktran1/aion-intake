/**
 * Pilot test harness.
 *
 * Spins up real Postgres in-process (PGlite), migrates it from zero, and seeds
 * the synthetic pilot. Every pilot test starts from the same known database,
 * so a failure is about the code rather than about leftover state.
 *
 * Migration is the slow part (a second or two), so a fixture is built once per
 * test file and reseeded between tests.
 */

import { pgliteDriver } from "@/lib/db/pglite";
import { migrate } from "@/lib/db/migrate";
import { seedPilot, type PilotSeed } from "@/lib/db/seed-pilot";
import { SqlStore } from "@/lib/store/sql";
import { LocalObjectStore } from "@/lib/objects/local";
import type { Driver } from "@/lib/db/driver";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_PEPPER = "test-pepper-".padEnd(48, "x");
export const TEST_SESSION_SECRET = "test-session-secret-".padEnd(48, "y");

export interface PilotFixture {
  driver: Driver;
  store: SqlStore;
  objects: LocalObjectStore;
  seed: PilotSeed;
  objectRoot: string;
  reseed(): Promise<void>;
  dispose(): Promise<void>;
}

export async function createPilotFixture(): Promise<PilotFixture> {
  const driver = await pgliteDriver();
  await migrate(driver);
  const objectRoot = await mkdtemp(join(tmpdir(), "aion-objects-"));
  const store = new SqlStore(driver, { pepper: TEST_PEPPER });
  const objects = new LocalObjectStore(objectRoot);

  const fixture: PilotFixture = {
    driver,
    store,
    objects,
    objectRoot,
    seed: await seedPilot(driver, TEST_PEPPER),
    async reseed() {
      fixture.seed = await seedPilot(driver, TEST_PEPPER);
      // Rate-limit buckets live in the database in pilot mode, so a test would
      // otherwise inherit the spent tokens of the one before it and fail for a
      // reason unrelated to what it is testing.
      await driver.query("DELETE FROM rate_limits");
    },
    async dispose() {
      await driver.close();
      await rm(objectRoot, { recursive: true, force: true });
    },
  };
  return fixture;
}

/** Convenience: the raw token for a seeded lifecycle state. */
export function tokenFor(seed: PilotSeed, label: string): string {
  const t = seed.tokens.find((x) => x.label === label);
  if (!t) throw new Error(`no seeded token "${label}"`);
  return t.rawToken;
}

export function intakeIdFor(seed: PilotSeed, label: string): string {
  const t = seed.tokens.find((x) => x.label === label);
  if (!t) throw new Error(`no seeded token "${label}"`);
  return t.intakeId;
}
