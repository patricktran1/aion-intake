-- Deletion outbox.
--
-- Deleting a photograph is two operations in two systems: a row in Postgres and
-- an object in a bucket. There is no transaction across both, so any ordering
-- has a crash window:
--
--   object first, then row  ->  a crash strands a row pointing at nothing
--   row first, then object  ->  a crash strands an ORPHANED PHOTOGRAPH that
--                               nothing references and nothing can ever find
--
-- The second is far worse: we would report the record deleted while the bytes
-- remain, which is a retention failure that looks like success. So the row goes
-- first, and the INTENT to delete the object is recorded in the same
-- transaction. A crash anywhere leaves a durable row here, and the sweeper
-- retries until the object is gone. Object deletion is idempotent, so a retry
-- against an already-deleted object simply resolves the entry.
--
-- This is an at-least-once outbox, which is exactly the guarantee wanted:
-- deletion converges to "gone" rather than being lost.
CREATE TABLE pending_object_deletions (
  object_key   TEXT PRIMARY KEY,
  practice_id  TEXT,
  -- Why this object is owed a deletion. Recorded for the operator, not the code.
  reason       TEXT NOT NULL DEFAULT 'deleted',
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error_at TIMESTAMPTZ
);

-- The sweeper takes fewest-attempts-first, then oldest. Ordering by age alone
-- would put a permanently failing key at the head of the queue forever,
-- starving every deletion enqueued behind it.
CREATE INDEX pending_object_deletions_order_idx ON pending_object_deletions (attempts, enqueued_at);
