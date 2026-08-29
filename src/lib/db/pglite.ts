/**
 * Postgres for tests and for local pilot development.
 *
 * PGlite is Postgres itself compiled to WebAssembly — the same parser, planner
 * and executor, running in-process. That matters more than convenience: the
 * pilot store's correctness rests on transactions, SELECT ... FOR UPDATE, and
 * unique-constraint conflicts, and a hand-written fake would simply agree with
 * whatever the code did. Here those behaviours are the real ones.
 *
 * What it is NOT is a deployment target. A pilot runs managed Postgres; this
 * exists so the pilot path can be exercised without one.
 */

import { driverFrom, type Driver } from "./driver";

export async function pgliteDriver(dataDir?: string): Promise<Driver> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = await PGlite.create(dataDir ? { dataDir } : undefined);
  return driverFrom(
    {
      query: async <R,>(sql: string, params?: unknown[]) => {
        const res = await pg.query<R>(sql, params as unknown[]);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
      exec: async (sql: string) => {
        await pg.exec(sql);
      },
      close: () => pg.close(),
    },
    // One connection, so transactions must not overlap. driverFrom serialises
    // them; without this two concurrent transactions would interleave their
    // statements into a single session and corrupt both.
    { exclusive: true },
  );
}
