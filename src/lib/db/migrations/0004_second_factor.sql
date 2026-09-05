-- Pluggable second factor.
--
-- The second factor was hard-wired to the patient's date of birth. It is a
-- reasonable default and a weak factor: family members know it, and it is often
-- discoverable. A practice that decides date of birth is not enough should be
-- able to require something else without a code change, so the choice moves to
-- configuration and the storage moves here.
--
-- `second_factor_kind` is per token rather than per practice: a practice
-- switching its policy must not lock out patients holding links issued under
-- the old one. A token verifies against the factor it was issued with.
--
-- `second_factor_hash` is a peppered hash, never the value. The date-of-birth
-- strategy leaves it NULL — that value already lives on the patient record and
-- duplicating it here would be a second copy of a patient identifier to protect
-- for no gain.
ALTER TABLE patient_tokens
  ADD COLUMN second_factor_kind TEXT NOT NULL DEFAULT 'dob',
  ADD COLUMN second_factor_hash TEXT,
  -- When a one-time code stops being acceptable. Separate from the token's own
  -- expiry: a code is short-lived, the link is not.
  ADD COLUMN second_factor_expires_at TIMESTAMPTZ;
