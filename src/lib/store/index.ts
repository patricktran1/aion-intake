/**
 * Storage.
 *
 * `store()` returns the adapter for the configured runtime mode: process
 * memory for the synthetic demo, Postgres for a pilot. The mode is explicit
 * (AION_RUNTIME_MODE) and validated at startup — see config/runtime.ts for why
 * it is never inferred.
 *
 * The synchronous helpers below are the demo's, re-exported from memory.ts so
 * that demo pages, the seed and the existing test suite keep working unchanged.
 * They throw nothing and know nothing about pilot mode; anything that must work
 * in both goes through `store()`.
 */

import { isPilot, pilotConfig } from "@/lib/config/runtime";
import { MemoryStore } from "./memory";
import { SqlStore } from "./sql";
import type { Store } from "./types";

export {
  db,
  resetDb,
  getIntake,
  getIntakeByToken,
  saveIntake,
  bundleFor,
  bundleByToken,
  bundleById,
  listBundles,
  MemoryStore,
} from "./memory";
export type { MemoryDb } from "./memory";
export { SqlStore } from "./sql";
export * from "./types";

const globalForStore = globalThis as unknown as { __aionStore?: Store };

/**
 * Builds the pilot store. `pg` is imported lazily and only here, so a demo
 * deployment never loads a database driver it will not use — and so a missing
 * `pg` install cannot break the demo.
 */
async function buildSqlStore(): Promise<Store> {
  const cfg = pilotConfig();
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  const { driverFrom } = await import("@/lib/db/driver");
  const { objectStore } = await import("@/lib/objects/select");
  // A pool hands each transaction its own connection, so transactions may
  // overlap freely; serialising them would be a self-inflicted bottleneck.
  const driver = driverFrom(
    {
      query: async (sql: string, params?: unknown[]) => {
        const res = await pool.query(sql, params as never[]);
        return { rows: res.rows, rowCount: res.rowCount ?? 0 };
      },
      close: () => pool.end(),
    },
    { exclusive: false },
  );
  return new SqlStore(driver, { pepper: cfg.tokenPepper, objects: await objectStore() });
}

/**
 * The configured store. Async because the pilot adapter has to construct a
 * connection pool; the demo adapter resolves immediately.
 */
export async function store(): Promise<Store> {
  if (!globalForStore.__aionStore) {
    globalForStore.__aionStore = isPilot() ? await buildSqlStore() : new MemoryStore();
    await globalForStore.__aionStore.init();
  }
  return globalForStore.__aionStore;
}

/** Test hook: install a specific store, or clear it so the next call rebuilds. */
export function setStore(s: Store | null): void {
  if (s) globalForStore.__aionStore = s;
  else delete globalForStore.__aionStore;
}
