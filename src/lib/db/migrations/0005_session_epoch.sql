-- Real logout.
--
-- The clinician session is a signed, stateless cookie. Logout cleared the
-- cookie from the browser and nothing else, so the cookie itself stayed valid
-- for the rest of its twelve hours: anyone who had captured it — a shared
-- machine, a proxy log, a screen recording — could keep using it after the
-- clinician had signed out and believed they were done. "Log out" that does not
-- end the session is the wrong kind of surprise on a screen showing patient
-- histories.
--
-- One integer closes it without introducing a session table. The epoch is
-- stamped into the cookie at issue and compared against the row on every
-- request; logout increments it, and every cookie carrying the old value stops
-- verifying. That is server-side revocation with no new table to migrate, no
-- new store to keep available, and no session state to expire.
ALTER TABLE clinicians
  ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
