import { describe, expect, it } from "vitest";
import { driverFrom, type PooledConnection, type QueryResult } from "@/lib/db/driver";

/**
 * The driver against a POOL, which is the only configuration a real pilot runs.
 *
 * Every other test in this repository drives PGlite: one connection, and
 * `exclusive: true` so transactions cannot overlap on it. That configuration
 * cannot express the defect this file is about, and for a long time nothing did.
 *
 * The defect: BEGIN, the caller's statements and COMMIT all went through one
 * `query` function, and for a pool that means each lands on whichever
 * connection is free. Two consequences, both silent:
 *
 *   1. The connection that received the BEGIN went back to the pool still
 *      inside an open transaction. Unrelated queries that later landed on it
 *      joined that transaction, and a COMMIT or ROLLBACK issued elsewhere
 *      decided their fate. One patient's failed request could roll back
 *      another patient's audit event.
 *   2. `SELECT ... FOR UPDATE` ran outside any transaction, so it took no lock
 *      that outlived the statement — and `withIntake`, which the entire store
 *      rests on for atomicity, was not atomic.
 *
 * The fake pool below is not standing in for Postgres. It is standing in for
 * the POOL: it records which connection each statement went to, which is
 * exactly what the real defect is about and exactly what a single-connection
 * database cannot show.
 */

interface Recorded {
  conn: number;
  sql: string;
}

function fakePool() {
  const log: Recorded[] = [];
  let nextId = 0;
  let inUse = 0;
  let maxInUse = 0;
  let released = 0;

  const query = async <R,>(conn: number, sql: string): Promise<QueryResult<R>> => {
    log.push({ conn, sql: sql.trim().split(/\s+/)[0].toUpperCase() });
    return { rows: [] as R[], rowCount: 0 };
  };

  return {
    log,
    get maxInUse() {
      return maxInUse;
    },
    get released() {
      return released;
    },
    get leaked() {
      return inUse;
    },
    base: {
      // A pooled query: a fresh connection every time, like pool.query().
      query: <R,>(sql: string) => query<R>((nextId += 1), sql),
      connect: async (): Promise<PooledConnection> => {
        const id = (nextId += 1);
        inUse += 1;
        maxInUse = Math.max(maxInUse, inUse);
        return {
          query: <R,>(sql: string) => query<R>(id, sql),
          release: () => {
            inUse -= 1;
            released += 1;
          },
        };
      },
    },
  };
}

/** Statements grouped by the connection that ran them. */
function byConnection(log: Recorded[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const r of log) out.set(r.conn, [...(out.get(r.conn) ?? []), r.sql]);
  return out;
}

describe("a transaction owns its connection", () => {
  it("BEGIN, the work and COMMIT all run on the same connection", async () => {
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });

    await driver.transaction(async (tx) => {
      await tx.query("SELECT 1");
      await tx.query("UPDATE intakes SET version = version + 1");
    });

    const groups = [...byConnection(pool.log).values()];
    expect(groups, "the transaction was spread across connections").toHaveLength(1);
    expect(groups[0]).toEqual(["BEGIN", "SELECT", "UPDATE", "COMMIT"]);
  });

  it("no connection is left holding an open transaction", async () => {
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });
    await driver.transaction(async (tx) => {
      await tx.query("SELECT 1");
    });
    for (const [, statements] of byConnection(pool.log)) {
      const opens = statements.filter((s) => s === "BEGIN").length;
      const closes = statements.filter((s) => s === "COMMIT" || s === "ROLLBACK").length;
      expect(opens, "an unbalanced BEGIN poisons the connection for every later request").toBe(closes);
    }
  });

  it("a rollback also happens on the transaction's own connection", async () => {
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });
    await expect(
      driver.transaction(async (tx) => {
        await tx.query("INSERT INTO x VALUES (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const groups = [...byConnection(pool.log).values()];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);
  });

  it("the connection is released, on success and on failure", async () => {
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });
    await driver.transaction(async (tx) => tx.query("SELECT 1"));
    await driver.transaction(async () => {
      throw new Error("boom");
    }).catch(() => {});
    expect(pool.released).toBe(2);
    expect(pool.leaked, "a connection never returned is one the pool loses").toBe(0);
  });

  it("a query that did not receive tx still runs inside the transaction", async () => {
    // A helper reaching for `driver.query` instead of the `tx` it was handed
    // would otherwise escape onto a different connection — outside the
    // transaction, outside its locks, and committed independently.
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });
    await driver.transaction(async () => {
      await driver.query("SELECT 2");
    });
    expect([...byConnection(pool.log).values()]).toHaveLength(1);
  });
});

describe("concurrent transactions do not join each other", () => {
  it("two overlapping transactions each open their own", async () => {
    // Re-entrancy used to be gated on a module-level counter shared by every
    // request, so a second request arriving while the first was inside saw
    // "already in a transaction" and skipped its own BEGIN — running its
    // statements bare inside a stranger's transaction.
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });

    let releaseA: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });

    const a = driver.transaction(async (tx) => {
      await tx.query("SELECT 'a'");
      await gate;
      await tx.query("UPDATE a SET x = 1");
    });
    // B starts while A is parked inside its transaction.
    const b = driver.transaction(async (tx) => {
      await tx.query("SELECT 'b'");
    });
    await b;
    releaseA();
    await a;

    const groups = byConnection(pool.log);
    expect(groups.size, "each transaction must have its own connection").toBe(2);
    for (const [, statements] of groups) {
      expect(statements.filter((s) => s === "BEGIN")).toHaveLength(1);
      expect(statements.filter((s) => s === "COMMIT" || s === "ROLLBACK")).toHaveLength(1);
    }
  });

  it("a failure in one does not roll back the other", async () => {
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });

    const ok = driver.transaction(async (tx) => {
      await tx.query("INSERT INTO audit VALUES ('kept')");
    });
    const bad = driver
      .transaction(async (tx) => {
        await tx.query("INSERT INTO audit VALUES ('discarded')");
        throw new Error("boom");
      })
      .catch(() => "rolled back");

    expect(await Promise.all([ok, bad])).toEqual([undefined, "rolled back"]);

    // The kept insert's connection committed; only the other one rolled back.
    const groups = [...byConnection(pool.log).entries()];
    const committed = groups.filter(([, s]) => s.includes("COMMIT"));
    const rolled = groups.filter(([, s]) => s.includes("ROLLBACK"));
    expect(committed).toHaveLength(1);
    expect(rolled).toHaveLength(1);
    expect(committed[0][1]).toContain("INSERT");
    expect(rolled[0][1]).toContain("INSERT");
    expect(committed[0][0]).not.toBe(rolled[0][0]);
  });

  it("genuine nesting still joins the outer transaction", async () => {
    const pool = fakePool();
    const driver = driverFrom(pool.base, { exclusive: false });
    await driver.transaction(async (tx) => {
      await tx.query("SELECT 'outer'");
      await driver.transaction(async (inner) => {
        await inner.query("SELECT 'inner'");
      });
    });
    const groups = [...byConnection(pool.log).values()];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(["BEGIN", "SELECT", "SELECT", "COMMIT"]);
  });
});

describe("the single-connection driver still serialises", () => {
  it("PGlite-style drivers without connect() do not overlap", async () => {
    // No connect(), exclusive: true — one connection, so overlapping
    // transactions would interleave their statements into one session.
    const pool = fakePool();
    const driver = driverFrom({ query: pool.base.query }, { exclusive: true });
    const order: string[] = [];
    await Promise.all([
      driver.transaction(async (tx) => {
        order.push("a-start");
        await tx.query("SELECT 1");
        order.push("a-end");
      }),
      driver.transaction(async (tx) => {
        order.push("b-start");
        await tx.query("SELECT 2");
        order.push("b-end");
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});
