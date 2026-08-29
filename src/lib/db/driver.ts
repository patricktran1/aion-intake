/**
 * The database driver seam.
 *
 * Three lines of interface, so that the pilot store can run against either a
 * real Postgres server (node-postgres, in deployment) or Postgres compiled to
 * WebAssembly (PGlite, in tests) without either one knowing about the other.
 *
 * The point is not portability across database engines — the SQL is Postgres
 * and is meant to be. The point is that the concurrency behaviour the pilot
 * depends on (transactions, SELECT ... FOR UPDATE, unique-constraint conflicts)
 * is tested against a real Postgres implementation rather than a hand-written
 * fake that would agree with whatever the code happens to do.
 */

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /**
   * Runs a script that may contain several statements. Separate from `query`
   * because the extended (parameterised) protocol both drivers use accepts
   * exactly one statement — migrations are the only caller, and they carry no
   * parameters, so this takes none.
   */
  exec(sql: string): Promise<void>;
}

export interface Driver extends Queryable {
  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Nested calls join the outer transaction rather than opening a
   * second one — a savepoint dance would add failure modes this product has
   * no use for.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Wraps any Queryable that supports BEGIN/COMMIT into a Driver. */
export function driverFrom(
  base: {
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
    /** Optional: a driver without it falls back to an unparameterised query. */
    exec?: (sql: string) => Promise<void>;
    close?: () => Promise<void>;
  },
  opts: { exclusive?: boolean } = {},
): Driver {
  const q: Queryable = {
    query: (sql, params) => base.query(sql, params),
    async exec(sql: string) {
      // node-postgres runs multi-statement SQL through the simple query
      // protocol as long as no parameters are supplied; PGlite needs its own
      // exec. Either way the caller gets one method that works.
      if (base.exec) await base.exec(sql);
      else await base.query(sql);
    },
  };
  let depth = 0;
  // PGlite is a single connection: overlapping transactions on it would
  // interleave statements into one another. Serialising them is correct and
  // costs nothing at pilot volume; a pooled driver passes exclusive: false.
  let chain: Promise<unknown> = Promise.resolve();

  const run = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    if (depth > 0) return fn(q);
    depth += 1;
    try {
      await base.query("BEGIN");
      const out = await fn(q);
      await base.query("COMMIT");
      return out;
    } catch (err) {
      try {
        await base.query("ROLLBACK");
      } catch {
        // A rollback that fails means the connection is already gone; the
        // original error is the one worth propagating.
      }
      throw err;
    } finally {
      depth -= 1;
    }
  };

  return {
    query: q.query,
    exec: q.exec,
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      if (!opts.exclusive) return run(fn);
      const next = chain.then(
        () => run(fn),
        () => run(fn),
      );
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async close() {
      await base.close?.();
    },
  };
}
