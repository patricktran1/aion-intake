/**
 * Logical backup and restore.
 *
 * This is NOT the production backup mechanism — a pilot uses the managed
 * provider's point-in-time recovery, and object storage uses bucket
 * versioning (see PILOT_SETUP.md). What this provides is a rehearsal that runs
 * anywhere, including against in-process Postgres, so the claim "we can restore
 * our data" is tested rather than asserted before the first patient.
 *
 * It dumps every application table to a JSON document and restores from it
 * inside one transaction (truncate, then reload in dependency order). The point
 * is to prove the data round-trips intact — every practice, clinician, visit,
 * intake, token, photo row and audit event — not to be fast or space-efficient.
 */

import type { Driver, Queryable } from "./driver";

/** Application tables, in an order safe to reload with foreign keys deferred. */
const TABLES = [
  "practices",
  "clinicians",
  "patients",
  "visits",
  "intakes",
  "patient_tokens",
  "photos",
  "audit_events",
  "idempotency_keys",
  "rate_limits",
  "schema_migrations",
] as const;

export interface Backup {
  takenAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function dumpDatabase(driver: Driver, takenAt: string): Promise<Backup> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) {
    const { rows } = await driver
      .query<Record<string, unknown>>(`SELECT * FROM ${table}`)
      .catch(() => ({ rows: [] as Record<string, unknown>[], rowCount: 0 }));
    tables[table] = rows;
  }
  return { takenAt, tables };
}

/**
 * Restores a dump into an empty-or-existing schema. Everything happens in one
 * transaction: a restore either fully succeeds or leaves the database as it
 * was, never half-loaded.
 */
export async function restoreDatabase(driver: Driver, backup: Backup): Promise<{ rows: number }> {
  return driver.transaction(async (tx) => {
    // Constraints are deferred so the reload order does not have to be perfect,
    // and children cannot be orphaned by a parent that loads later.
    await tx.query("SET CONSTRAINTS ALL DEFERRED").catch(() => undefined);
    // Truncate in reverse dependency order.
    for (const table of [...TABLES].reverse()) {
      await tx.query(`DELETE FROM ${table}`).catch(() => undefined);
    }
    let total = 0;
    for (const table of TABLES) {
      for (const row of backup.tables[table] ?? []) {
        total += await insertRow(tx, table, row);
      }
    }
    return { rows: total };
  });
}

async function insertRow(tx: Queryable, table: string, row: Record<string, unknown>): Promise<number> {
  const cols = Object.keys(row);
  if (cols.length === 0) return 0;
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const values = cols.map((c) => normalize(row[c]));
  const { rowCount } = await tx.query(
    `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
    values,
  );
  return rowCount;
}

/** JSON/JSONB columns come back as objects; re-serialise so the driver binds them. */
function normalize(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return JSON.stringify(v);
  }
  return v;
}
