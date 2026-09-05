# Pilot setup

Zero to a running pilot environment with synthetic data. Written for an
engineer who has not seen this repository before.

**This sets up the technical environment only.** It does not make the system
lawful to use with patients — see PILOT_READINESS.md for what has to be true
before a real person's history goes into it, and EXTERNAL BLOCKERS at the
bottom of this file for what nobody can do from a terminal.

---

## The five-minute version

```bash
npm install
npm run dev:pilot
```

That runs the entire pilot architecture locally: durable schema, clinician
authentication, practice isolation, patient verification, private photo
storage, audit trail, retention. No database server, no cloud account, no
credentials — Postgres runs in-process and objects go to a local directory.

It prints the seeded sign-ins and patient links. Everything is synthetic.

---

## What it is made of

```
browser ──► Next.js app ──► Postgres        (practices, visits, intakes, audit)
                        └─► object store    (photographs, private)
                        └─► model provider  (optional; off by default)
```

Four things you supply for a real pilot, and nothing else:

| | What | Why |
|---|---|---|
| 1 | Managed Postgres | Durable records. The whole store is eight functions. |
| 2 | Private object storage | Photographs, S3-compatible or a mounted volume. |
| 3 | Two secrets | Session signing and token peppering. |
| 4 | A retention decision | How long records are kept. There is no safe default. |

An Anthropic API key is deliberately **not** on that list. The product runs
fully without one and sends nothing to any third party in that state.

---

## Environment

Copy `.env.example` to `.env.local`. The variables pilot mode requires:

```bash
AION_RUNTIME_MODE=pilot

# Postgres. Or pglite:<dir> for local development, which pilot:check flags
# as non-durable so it cannot be mistaken for a deployment.
DATABASE_URL=postgres://user:password@host:5432/aion

# 32+ characters each, and different from one another:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
AION_SESSION_SECRET=...
AION_TOKEN_PEPPER=...

AION_OBJECT_STORE=s3
AION_S3_BUCKET=aion-pilot-photos
AION_S3_REGION=us-east-1
AION_S3_ACCESS_KEY_ID=...
AION_S3_SECRET_ACCESS_KEY=...

AION_PHOTO_RETENTION_DAYS=30
AION_INTAKE_RETENTION_DAYS=90
AION_PATIENT_TOKEN_TTL_HOURS=72
```

The app refuses to start if any of these is missing, is a well-known
placeholder, is under 32 characters, or if the two secrets are the same value.
It reports every problem at once rather than one per restart.

**`AION_TOKEN_PEPPER` is load-bearing in an unusual way.** Patient links are
stored only as a peppered hash, so rotating it invalidates every outstanding
link at once. That is the emergency lever — worth knowing before you need it,
and worth not rotating casually.

### The object store must be private

No bucket policy granting public read, no static website hosting, no CDN in
front. The application never produces a public or pre-signed URL: photo bytes
are fetched server-side after an authorization check and streamed to the
clinician. A pre-signed URL would be a forwardable, unrevokable bearer token
for a photograph of someone's skin, which is exactly the property the patient
token work removed.

Enable server-side encryption and versioning on the bucket. The S3 adapter
requests `AES256` explicitly rather than relying on a bucket default, so a
misconfigured bucket fails loudly at upload rather than silently storing
plaintext.

---

## Migrations

```bash
npm run db:migrate
```

Plain SQL files in `src/lib/db/migrations`, applied in filename order, each in
its own transaction, each recorded with a checksum. Editing a migration that
has already been applied is refused — the database and the repository would
disagree about the schema, and later migrations would run against an unknown
shape. Add a new file instead.

There is no rollback machinery, deliberately. For a schema this size the SQL
is the clearest description of the database, and a rollback path that has
never been rehearsed is a liability rather than a safety net. Rolling back
means restoring a backup; see BACKUP below.

---

## Clinician accounts

The synthetic seed creates them. For a real pilot, insert them directly —
there is no self-service registration and there should not be:

```bash
node -e "
  const { hashPassword } = require('./dist/lib/auth/password');
  hashPassword(process.argv[1]).then(console.log);
" 'the-password'
```

```sql
INSERT INTO practices (id, name) VALUES ('prac_northgate', 'Northgate Dermatology');
INSERT INTO clinicians (id, practice_id, email, display_name, credential, password_hash)
VALUES ('cli_okonkwo', 'prac_northgate', 'okonkwo@northgate.example', 'A. Okonkwo', 'MD', '<hash>');
```

Disable an account by setting `disabled_at`. It takes effect on the next
request, not when the cookie expires, because the account is re-read every
time.

---

## Issuing a patient link

A link is minted per visit, hashed, and given an expiry. The raw token is
returned exactly once — it is not recoverable from the database afterwards,
which is the point.

```ts
import { mintToken, expiryFrom } from "@/lib/patient/token";

const raw = mintToken();
await store.issueToken(intakeId, practiceId, raw, expiryFrom(new Date(), 72));
// Send `https://your-host/intake/${raw}` to the patient. Store nothing.
```

Opening it requires the patient's date of birth. Five wrong answers kill the
token and the practice must reissue. `store.revokeToken(intakeId)` kills it
immediately — for a cancelled appointment, or a link sent to the wrong number.

---

## Verify

```bash
npm run pilot:check
```

```
TECHNICAL PILOT READINESS
────────────────────────────────────────────────────────────────
PASS  configuration valid            mode=pilot
PASS  runtime mode                   pilot
PASS  session secret configured      AION_SESSION_SECRET
PASS  token pepper configured        AION_TOKEN_PEPPER
PASS  retention policy chosen        photos 30d, intakes 90d
PASS  database reachable             postgres://user:***@host:5432/aion
PASS  schema migrated                1 migrations applied
PASS  object storage writable        s3:aion-pilot-photos
PASS  clinician accounts exist       3 enabled
PASS  model provider boundary        disabled — no patient text leaves
```

**This is a technical check.** It says nothing about HIPAA compliance, signed
BAAs, independent review, or whether a retention period is lawful. It is named
`pilot:check`, not `compliance:check`, on purpose.

---

## Test deletion before the first patient

Do this. A deletion path nobody has exercised is a deletion path that does not
work, and the first time you need it will be when someone asks you to remove
their record.

```bash
npm run pilot:retention              # dry run: what is due
npm run pilot:retention -- --apply   # delete it
npm run pilot:reconcile              # drain anything the bytes still owe
```

Deletion removes, in one transaction: the intake, its messages, its facts, its
photo rows, the patient token, **the visit** and **the patient** — the last two
because this product holds one visit per intake and no longitudinal record, so
a visit with no intake has nothing left to be, and a patient with no visits has
no reason to exist here. A patient with another appointment still inside the
window is kept: they are a live record, not a leftover.

The photograph BYTES are a second system with no transaction across the two, so
the intent to delete them is written in the same transaction as the rows
(`pending_object_deletions`) and a sweeper retries until each object is
confirmed gone. That means a crash or a storage outage during deletion delays
the bytes rather than stranding them: `pilot:reconcile` finishes the job, and
reports any key that has failed repeatedly, which is a credentials problem
rather than something another retry fixes.

Audit events survive their subject by design: the record is gone, the fact that
it existed and was deleted is not.

Verify by hand, once:

```sql
SELECT count(*) FROM photos WHERE intake_id = '<deleted id>';         -- 0
SELECT count(*) FROM patient_tokens WHERE intake_id = '<deleted id>'; -- 0
SELECT count(*) FROM visits WHERE id = '<the visit id>';              -- 0
SELECT count(*) FROM patients WHERE id = '<the patient id>';          -- 0
SELECT count(*) FROM pending_object_deletions;                        -- 0
SELECT count(*) FROM audit_events WHERE resource_id = '<deleted id>'; -- > 0
```

And confirm the objects are gone from the bucket, not just the rows.

**Intakes nobody submitted** are collected too, on the shorter (photo) window.
A patient who opened their link, typed a symptom and closed the tab used to
leave a record with no retention clock on it at all.

---

## Backup and restore

Two things to back up, and they must be restored to a consistent pair:

- **Postgres** — managed provider's point-in-time recovery. Verify the
  retention window is at least as long as your intake retention period.
- **Object storage** — bucket versioning plus a lifecycle rule. Note that
  versioning and deletion pull against each other: a deleted photograph whose
  previous version is retained is not deleted. Configure the lifecycle rule to
  expire non-current versions inside your retention window, or deletion is a
  fiction.

Restoring the database without the objects yields briefs whose photographs
404. Restoring objects without the database yields orphaned files nothing
points to. Neither is catastrophic; both are confusing at the worst moment, so
restore both to the same point.

Rehearse a restore into a scratch database before the pilot starts. The test
you want to run is: seed synthetic data, back up, delete everything, restore,
and confirm `npm run pilot:check` passes and a brief still renders.

---

## Running it

```bash
npm run build
npm start
```

One instance is a legitimate pilot choice at this volume — 2,000 intakes a
month is three an hour. Two instances buy availability, and note what changes
if you run two: the in-process rate limiter and the demo's write lock both
become per-instance. The write lock does not matter (pilot mode uses database
row locks), but rate limiting does — see PILOT_ARCHITECTURE.md.

---

## What is still external

Nothing in this file makes the system lawful to use. Still required, and none
of it obtainable from a terminal:

- **Business Associate Agreements** with the host, the database provider, the
  object storage provider, and the model provider if one is enabled.
- **An independent security review.** SECURITY_REVIEW_PACKET.md exists to make
  that review cheap to run; it is not a substitute for one.
- **A retention determination** from someone qualified to make it. The
  mechanism is configurable; the lawful number is not an engineering decision.
- **A breach notification procedure**, which is a process rather than code.
- **Patient-facing consent language** reviewed by counsel.
