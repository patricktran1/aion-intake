/**
 * Migrations.
 *
 * Plain SQL files applied in filename order, each in its own transaction, each
 * recorded once. No ORM, no migration DSL, no rollback machinery: for a schema
 * this size the SQL is the clearest possible description of the database, and
 * a rollback that has never been rehearsed is a liability rather than a
 * safety net. Rolling back means restoring a backup, which is documented.
 *
 * The one guarantee worth having is reproducibility from zero, so that a
 * developer, CI, and a pilot deployment all end up with the same schema. That
 * is what `migrate()` provides and what `npm run db:migrate` exercises.
 */

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Driver } from "./driver";
import { log } from "@/lib/log";

export const MIGRATIONS_DIR = join(process.cwd(), "src", "lib", "db", "migrations");

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16) };
    });
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(driver: Driver, dir?: string): Promise<MigrateResult> {
  await driver.query(LEDGER);
  const { rows } = await driver.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const seen = new Map(rows.map((r) => [r.name, r.checksum]));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const m of loadMigrations(dir)) {
    const existing = seen.get(m.name);
    if (existing !== undefined) {
      // An applied migration whose file has since changed means the database
      // and the repository disagree about the schema. Continuing would apply
      // later migrations onto an unknown shape, so stop.
      if (existing !== m.checksum) {
        throw new Error(
          `Migration ${m.name} has changed since it was applied ` +
            `(recorded ${existing}, file ${m.checksum}). Add a new migration instead of editing an applied one.`,
        );
      }
      alreadyApplied.push(m.name);
      continue;
    }
    await driver.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [m.name, m.checksum]);
    });
    applied.push(m.name);
    log.info("migration applied", { migration: m.name });
  }

  return { applied, alreadyApplied };
}

/** True when every migration on disk is recorded as applied. */
export async function isUpToDate(driver: Driver, dir?: string): Promise<boolean> {
  const { rows } = await driver
    .query<{ name: string }>("SELECT name FROM schema_migrations")
    .catch(() => ({ rows: [] as { name: string }[], rowCount: 0 }));
  const have = new Set(rows.map((r) => r.name));
  return loadMigrations(dir).every((m) => have.has(m.name));
}
