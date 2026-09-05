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
 *
 * A TRANSACTION MUST OWN ITS CONNECTION. This file used to send BEGIN, the
 * caller's statements, and COMMIT through the same `query` function — which for
 * a connection pool means each one goes to whichever connection is free. The
 * consequences in a pooled deployment, which is every real pilot:
 *
 *   - BEGIN ran on connection A, which then went back to the pool still inside
 *     an open transaction. Every unrelated query that later landed on A joined
 *     it, and the eventual COMMIT or ROLLBACK — issued on some other connection
 *     entirely — committed or discarded whatever had accumulated there. An
 *     audit write from one patient could be rolled back by another patient's
 *     failed request.
 *   - `SELECT ... FOR UPDATE` ran outside any transaction, so it took no lock
 *     that outlived the statement. `withIntake`, the single mechanism the whole
 *     store rests on for atomicity, was not atomic.
 *
 * None of it was visible in tests: PGlite is one connection, so the statements
 * happened to land in the right place. The guarantee held in the configuration
 * that was tested and not in the configuration that ships.
 *
 * Re-entrancy had the same shape of bug. "Nested calls join the outer
 * transaction" was implemented with a module-level counter, which is shared
 * across every concurrent request rather than scoped to one. Request B entering
 * `transaction` while A was inside saw depth > 0 and skipped its BEGIN
 * entirely, running its statements bare inside A's transaction. The counter is
 * now an AsyncLocalStorage, which is per-async-context and therefore per
 * request.
 */

import { AsyncLocalStorage } from "node:async_hooks";

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
   * Runs `fn` inside a transaction on a connection held for its whole
   * lifetime, committing on return and rolling back on throw. Nested calls
   * join the outer transaction rather than opening a second one — a savepoint
   * dance would add failure modes this product has no use for.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** One checked-out connection, held for the life of a transaction. */
export interface PooledConnection {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  exec?: (sql: string) => Promise<void>;
  release(): void;
}

export interface DriverBase {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  /** Optional: a driver without it falls back to an unparameterised query. */
  exec?: (sql: string) => Promise<void>;
  /**
   * Checks out a connection for a transaction's exclusive use. Required for
   * anything pooled. A single-connection driver (PGlite) may omit it: there is
   * only one connection, and `exclusive: true` keeps transactions from
   * overlapping on it.
   */
  connect?: () => Promise<PooledConnection>;
  close?: () => Promise<void>;
}

/**
 * The transaction in scope for the current async context, if any. Everything a
 * request does inside `transaction` — including a `driver.query` that did not
 * receive `tx` — goes to that transaction's own connection rather than to an
 * arbitrary one from the pool.
 */
const current = new AsyncLocalStorage<Queryable>();

/** Wraps any base that supports BEGIN/COMMIT into a Driver. */
export function driverFrom(base: DriverBase, opts: { exclusive?: boolean } = {}): Driver {
  const wrap = (q: {
    query: DriverBase["query"];
    exec?: (sql: string) => Promise<void>;
  }): Queryable => ({
    query: (sql, params) => q.query(sql, params),
    async exec(sql: string) {
      // node-postgres runs multi-statement SQL through the simple query
      // protocol as long as no parameters are supplied; PGlite needs its own
      // exec. Either way the caller gets one method that works.
      if (q.exec) await q.exec(sql);
      else await q.query(sql);
    },
  });

  const outer = wrap(base);
  // PGlite is a single connection: overlapping transactions on it would
  // interleave statements into one another. Serialising them is correct and
  // costs nothing at pilot volume; a pooled driver passes exclusive: false and
  // gets a real connection per transaction instead.
  let chain: Promise<unknown> = Promise.resolve();

  const run = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    const conn = base.connect ? await base.connect() : null;
    const tx = conn ? wrap(conn) : outer;
    try {
      await tx.query("BEGIN");
      try {
        // Inside this scope, `driver.query` resolves to `tx` too, so a helper
        // that did not thread `tx` through cannot silently escape the
        // transaction onto another connection.
        const out = await current.run(tx, () => fn(tx));
        await tx.query("COMMIT");
        return out;
      } catch (err) {
        try {
          await tx.query("ROLLBACK");
        } catch {
          // A rollback that fails means the connection is already gone; the
          // original error is the one worth propagating.
        }
        throw err;
      }
    } finally {
      // Always released, including after a failed ROLLBACK — a connection
      // leaked here is one the pool never gets back.
      conn?.release();
    }
  };

  return {
    // Outside a transaction these go to the pool; inside one they go to that
    // transaction's connection.
    query: (sql, params) => (current.getStore() ?? outer).query(sql, params),
    exec: (sql) => (current.getStore() ?? outer).exec(sql),
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // Genuinely nested: join the transaction already in scope. Per async
      // context, so a concurrent request never joins someone else's.
      const inTx = current.getStore();
      if (inTx) return fn(inTx);

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
