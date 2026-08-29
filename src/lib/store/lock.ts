/**
 * Per-intake write serialization.
 *
 * Every intake write is a read-modify-write on an in-process store, and every
 * route awaits at least once (body parse, model call) between the read and the
 * write. Two concurrent requests for the same intake would therefore both read
 * the same snapshot and the second save would silently erase the first turn —
 * a lost patient answer, the worst kind of quiet data loss.
 *
 * The fix is a keyed promise chain: writes for the same intake run one after
 * another, writes for different intakes (different patients in the waiting
 * room) never wait on each other. This is correct precisely because the store
 * is in-process; a multi-instance deployment replaces this file together with
 * the store (transactions or optimistic versioning — see PILOT_ARCHITECTURE.md).
 */

const tails = new Map<string, Promise<void>>();

export function withIntakeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // The stored tail never rejects, so chaining on `then` alone is safe.
  const result = prev.then(fn);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    // Drop the entry once the queue drains so the map does not grow forever.
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

/** Test hook: number of intakes with a queue currently held open. */
export function pendingLockCount(): number {
  return tails.size;
}
