-- Shared rate limiting.
--
-- The in-process token bucket is correct for one instance and silently wrong
-- for two: each instance keeps its own counters, so an attacker gets N times
-- the budget and a legitimate user can be throttled by whichever instance
-- happens to hold their history. At pilot volume the fix does not need Redis —
-- a single row per key, updated atomically, is a few hundred writes an hour.
--
-- The bucket is stored as (tokens, updated_at) and refilled arithmetically on
-- read, so there is no background job and no clock to keep in step.
CREATE TABLE rate_limits (
  key         TEXT PRIMARY KEY,
  tokens      DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Buckets are disposable: an evicted row simply refills to full. This index
-- lets a sweep drop idle ones without scanning the table.
CREATE INDEX rate_limits_updated_idx ON rate_limits (updated_at);
