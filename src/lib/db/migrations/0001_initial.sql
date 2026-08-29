-- AION Intake — pilot schema.
--
-- Scoped to one job: gather a dermatology history before a visit and hand the
-- clinician a brief. It is not a chart and must not grow into one. Every table
-- below exists because the brief cannot be produced or audited without it.
--
-- Notably absent, and to stay absent: encounters, problems, allergies as
-- coded entities, medications as coded entities, orders, results, billing,
-- scheduling, messaging, or any longitudinal patient view. A patient here is
-- a name and a date of birth for one visit, because that is what it takes to
-- put the right brief in front of the right clinician.

CREATE TABLE practices (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clinicians (
  id             TEXT PRIMARY KEY,
  practice_id    TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  credential     TEXT NOT NULL DEFAULT '',
  password_hash  TEXT NOT NULL,
  disabled_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Email identifies an account globally: a person signing in types an address,
-- not an address plus a practice.
CREATE UNIQUE INDEX clinicians_email_key ON clinicians (lower(email));
CREATE INDEX clinicians_practice_idx ON clinicians (practice_id);

-- The patient record holds the minimum needed to route a brief to the right
-- person at the right appointment: a name to show the clinician, and a date of
-- birth that doubles as the patient's second factor. No contact details, no
-- address, no identifiers issued by anyone else.
CREATE TABLE patients (
  id             TEXT PRIMARY KEY,
  practice_id    TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  first_name     TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  date_of_birth  DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX patients_practice_idx ON patients (practice_id);

CREATE TABLE visits (
  id             TEXT PRIMARY KEY,
  practice_id    TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  patient_id     TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  scheduled_for  TIMESTAMPTZ NOT NULL,
  reason_booked  TEXT NOT NULL DEFAULT '',
  location       TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX visits_practice_idx ON visits (practice_id, scheduled_for);

-- The intake.
--
-- The conversational state lives in one JSONB document rather than a dozen
-- child tables. This is a deliberate trade: the interview engine owns that
-- shape, it is read and written whole on every turn, and it is never queried
-- field by field. Splitting it into tables would buy query flexibility this
-- product does not use and cost a join per turn plus a migration per engine
-- change. The columns promoted out of the document are exactly the ones the
-- database needs to enforce something: tenancy, status, lifecycle, retention.
CREATE TABLE intakes (
  id             TEXT PRIMARY KEY,
  practice_id    TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  visit_id       TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('not_started','in_progress','ready_for_review','reviewed')),
  pathway        TEXT NOT NULL,
  urgent_flag    BOOLEAN NOT NULL DEFAULT false,
  -- Optimistic concurrency. Every write bumps it; a writer that read an older
  -- version is rejected rather than silently overwriting.
  version        INTEGER NOT NULL DEFAULT 1,
  document       JSONB NOT NULL,
  started_at     TIMESTAMPTZ,
  submitted_at   TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One intake per visit. This is the database saying what the product means:
-- a second intake for the same appointment is a bug, not a feature.
CREATE UNIQUE INDEX intakes_visit_key ON intakes (visit_id);
CREATE INDEX intakes_practice_status_idx ON intakes (practice_id, status);
CREATE INDEX intakes_retention_idx ON intakes (submitted_at) WHERE deleted_at IS NULL;

-- Patient access tokens.
--
-- Only a peppered hash is stored, so a dump of this table yields no working
-- links. One live token per intake; reissuing replaces the row.
CREATE TABLE patient_tokens (
  intake_id             TEXT PRIMARY KEY REFERENCES intakes(id) ON DELETE CASCADE,
  practice_id           TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  token_hash            TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  verified_at           TIMESTAMPTZ,
  failed_verifications  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX patient_tokens_hash_key ON patient_tokens (token_hash);

-- Photo metadata. The bytes live in object storage; this table holds the key
-- and enough to authorize access to it. There is no public URL anywhere.
CREATE TABLE photos (
  id             TEXT PRIMARY KEY,
  intake_id      TEXT NOT NULL REFERENCES intakes(id) ON DELETE CASCADE,
  practice_id    TEXT NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
  object_key     TEXT NOT NULL UNIQUE,
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'unspecified',
  caption        TEXT NOT NULL DEFAULT '',
  advisories     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Set by the uploader so a retried upload cannot create a second row.
  idempotency_key TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX photos_intake_idx ON photos (intake_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX photos_idempotency_key ON photos (intake_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Audit events.
--
-- Append-only by convention and by permission: the application never issues an
-- UPDATE or DELETE against this table, and a pilot deployment should grant the
-- application role INSERT and SELECT only. Events record that an action
-- happened to a resource — never what the resource says. `meta` is for counts
-- and enums; putting clinical text in it defeats the point of the table.
CREATE TABLE audit_events (
  id             BIGSERIAL PRIMARY KEY,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  action         TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  actor_id       TEXT,
  practice_id    TEXT,
  resource       TEXT NOT NULL,
  resource_id    TEXT,
  request_id     TEXT,
  meta           JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_practice_at_idx ON audit_events (practice_id, at DESC);
CREATE INDEX audit_resource_idx ON audit_events (resource_id, at DESC);

-- Idempotency for non-photo writes that must tolerate a retry, chiefly submit.
CREATE TABLE idempotency_keys (
  scope          TEXT NOT NULL,
  key            TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
