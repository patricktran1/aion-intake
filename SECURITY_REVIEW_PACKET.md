# Security review packet

For an independent security engineer. The goal of this document is to make
attacking this system cheap: here is the architecture, here is what we believe
holds, here is where we think it is weakest, and here is how to run it in
twenty seconds.

**This system has not been independently reviewed.** That is the point of
giving you this. Nothing here should be read as an assurance.

---

## Twenty-second start

```bash
npm install && npm run dev:pilot
```

Runs the full pilot architecture locally with synthetic data — Postgres
in-process, objects on disk, real authentication, real tenancy, real audit.
It prints seeded clinician sign-ins and patient links covering every token
lifecycle state (live, active, submitted, expired, revoked, reviewed) across
two practices.

```bash
npm test                     # 900+ tests
npx vitest run tests/pilot-  # the pilot suites specifically
npm run pilot:check          # technical readiness
npm run smoke                # repository-level security checks
```

---

## What the product is

A pre-visit dermatology intake. A patient answers an adaptive interview on
their phone before an appointment; the dermatologist gets a brief, a draft
HPI, and a short list of things to clarify in the room. It is not an EHR and
holds no longitudinal record — one visit, one complaint, one brief.

It runs as one of two things, chosen by `AION_RUNTIME_MODE`:

- **demo** — synthetic data in process memory. The public deployment.
- **pilot** — Postgres, clinician accounts, visit-bound patient links, private
  object storage, audit trail.

---

## Trust boundaries

| Boundary | Who is on the far side | What crosses it |
|---|---|---|
| Patient browser → app | Anyone holding a link | Answers, photographs, a date of birth |
| Clinician browser → app | A signed-in clinician | Session cookie, CSRF token, edits |
| App → Postgres | Managed provider | Everything |
| App → object storage | Managed provider | Photograph bytes |
| App → model provider | Anthropic (optional, off by default) | One answer at a time |
| App → logs | Whoever reads logs | Ids, timings, statuses. No content. |

---

## Authentication and sessions

- **Clinician**: scrypt (N=2^15, r=8, p=1) via `node:crypto`, parameters and
  salt stored per hash. Session is a stateless HMAC-SHA256-signed cookie
  carrying `{clinicianId, practiceId, exp, csrf}`; HttpOnly, Secure, SameSite=Lax,
  12-hour TTL. The account is re-read from the database on every request, so
  disabling one takes effect immediately.
- **Failed login** costs the same whether or not the address exists (unknown
  addresses verify against a dummy hash) and returns one message for every
  failure mode. Rate limited per email address, not per IP — a clinic shares
  one address, and per-IP limiting would let one attacker lock out a practice.
- **CSRF**: double-submit. The session's random token must be echoed in
  `x-aion-csrf`, which a cross-site form cannot set. Origin is checked
  additionally where the browser sends it.

**Where we think this is weakest:** local password accounts are not an
identity provider. There is no MFA, no password rotation, no lockout on the
account itself (only rate limiting), and no session revocation short of
disabling the account. The intended endpoint is OIDC; `requireClinician()` in
`src/lib/auth/guard.ts` is the seam.

---

## Patient access

- Token: 32 bytes from `randomBytes`, base64url. **Only a peppered SHA-256 is
  stored.** The pepper is in the environment, not the database, so a database
  dump yields no working links.
- Expiry (`AION_PATIENT_TOKEN_TTL_HOURS`, default 72) and revocation are both
  evaluated in SQL at resolution time.
- Second factor: date of birth, normalised across common formats, compared in
  constant time. Five failures kill the token permanently; the counter is in
  the database, so it survives restarts and cannot be reset by hitting another
  instance.
- SHA-256 rather than a slow KDF is deliberate: the input is 256 bits of
  entropy, so there is no dictionary to slow down, and lookup is by token hash
  on the request path.

**Where we think this is weakest:** date of birth is a weak second factor —
family members know it, and it is often discoverable. It defends against the
actual pilot threat (a forwarded SMS) and not against a determined party who
already holds the link. A practice-issued one-time code would be stronger and
the mechanism supports it; nobody has decided to require one.

Also: the token is in the URL path, so it can land in browser history and in
any intermediary that logs full URLs. The expiry and second factor exist
because of this.

---

## Tenancy

Every clinician query carries `practice_id` **in the WHERE clause**. Another
practice's record is never read, rather than read and then filtered — so there
is no path where the filter is the only thing between two practices' patients.
The practice id comes from the signed session, never from a URL or body.

`tests/pilot-isolation.test.ts` attacks this directly. Deleting `practice_id`
from that one query turns the suite red, which is how we know the boundary is
load-bearing rather than decorative.

**Where we think this is weakest:** it is enforced in application code, not by
Postgres row-level security. A future query written without the clause would
compile and pass most tests.

**RLS decision (evidence-based, revisit at scale).** We evaluated row-level
security and chose not to implement it *yet*. For: it is genuine
defense-in-depth — a query that forgot its practice filter would return nothing
instead of another tenant's rows. Against: RLS requires every pooled connection
to set a per-request tenant context (`SET app.practice_id`) before each query,
which is itself a new thing to get wrong (a forgotten SET fails open or closed
depending on the policy, and a connection pool makes leakage of that context
across requests a fresh failure mode); it complicates the migration and test
story; and the query surface it would protect is small and already
mutation-tested (deleting the one WHERE clause turns `tests/pilot-isolation`
red). At 5–20 clinicians the operational risk of the tenant-context plumbing is
not clearly smaller than the risk it removes. The decision is to keep
application isolation, keep it mutation-tested, and add RLS as defense-in-depth
when the query surface or the tenant count grows. This is a documented choice,
not an oversight.

---

## Photographs

- Keys are `practice/intake/<16 random bytes>.ext`. Knowing an intake id does
  not let you construct a key.
- The bucket is private. **There is no public URL and no pre-signed URL**, by
  design: a pre-signed URL is a forwardable, unrevokable bearer token for a
  photograph of someone's skin. Bytes are fetched server-side after an
  authorization check and streamed, with `Cache-Control: private, no-store`.
- Every read is audited.
- Uploads are validated by inspecting the actual bytes (PNG IHDR, JPEG SOF
  markers, WebP VP8/VP8L/VP8X) — client-declared mime and dimensions are
  discarded. No decoder runs, so there is no image-parsing attack surface. A
  JPEG carrying EXIF is **rejected**, not stripped, because the browser's
  canvas re-encode never produces EXIF and its presence means someone bypassed
  the client.
- The local filesystem adapter validates every key twice (shape, then resolved
  path inside the root) before touching disk.

**Signing** is delegated to `aws4fetch`, a small (65KB, zero-dependency),
maintained SigV4-over-fetch library, not to hand-written crypto. An earlier
version of this file carried a bespoke SigV4 implementation; it was the #1 item
on this list and has been removed. The adapter is tested against a mock S3
endpoint (`tests/pilot-s3.test.ts`) which asserts every request is SigV4-signed,
encryption is requested on upload, path/key addressing is correct, and the CRUD
lifecycle round-trips. It has still not been exercised against a *live* bucket
in this repository — that remains provider validation (see below).

---

## Concurrency

`store.withIntake()` opens a transaction and takes `SELECT ... FOR UPDATE` on
the intake row. Two requests for the same intake serialise in the database, so
a second web instance changes nothing. There is also an optimistic `version`
column, so any future path that skips the lock fails loudly rather than
overwriting silently.

Tested against real Postgres — PGlite is Postgres compiled to WebAssembly, so
transactions, row locks and constraint conflicts are the genuine
implementations rather than a fake that would agree with whatever the code does.

Photo uploads carry an idempotency key with a partial unique index, so a retry
cannot create a second photo.

Every patient and clinician write route goes through `store.withIntake` — a
row lock in pilot, a promise chain in demo. This was not always true: an
earlier version resolved tokens and saved intakes through the in-memory helpers
directly, so in pilot mode patient answers and clinician edits went to process
memory and 404'd or vanished. `tests/pilot-patient-flow` and
`tests/pilot-rehearsal` read straight from Postgres to prove every write now
lands there.

---

## Logging, audit, errors

- **Logs** allowlist which fields may carry a string; anything else is dropped.
  A string that looks like prose is dropped rather than truncated.
- **Audit** records action/actor/practice/resource/timestamp/request-id, plus
  small non-clinical meta. Values over 64 characters are dropped. Audit rows
  survive the deletion of their subject by design.
- **Errors** go through a fixed taxonomy. The client receives a code, a safe
  message and a request id. A Postgres error, a provider response, a
  connection string and a stack trace cannot reach a client — asserted in
  `tests/pilot-audit.test.ts`.

**Where we think this is weakest:** the audit table is append-only by
convention and by the application never issuing UPDATE or DELETE against it.
It is not append-only by permission. A deployment should grant the application
role INSERT and SELECT only; nothing enforces that from here.

---

## The highest-risk areas, ranked

If you have limited time, spend it here:

1. **Tenancy in application code rather than RLS.** Look for any query path
   that could reach an intake without a practice id — particularly anything
   added after this document was written.
2. **Date of birth as the second factor.** Is it enough for the threat you
   think a pilot faces?
3. **The patient token in the URL path.** History, referrers, proxy logs.
4. **Session revocation.** A stolen cookie is valid for up to 12 hours unless
   the account is disabled.
5. **The JSONB intake document.** It is parsed back through a Zod schema, but
   it is the one place where a large attacker-influenced structure is stored
   and re-read.
6. **Local password accounts.** No MFA. Is scrypt configured correctly here?
7. **The S3 object store against a live bucket.** The signing is now a library
   and is tested against a mock, but no live-bucket round-trip has run here.

---

## What we deliberately did not build

Listed so you do not spend time looking for it: row-level security, an
identity provider integration, MFA, a session store, field-level encryption,
key rotation tooling, a WAF, intrusion detection, SIEM integration, and
anomaly detection. At 5–20 clinicians and 100–2,000 intakes a month these
would be architectural theatre, and each one added would be another thing
running unmonitored. Several belong in a second phase; none is claimed to
exist.

---

## Reporting

Findings to the repository owner. If a finding is exploitable against the
public demo, note that it holds only synthetic data — but report it anyway,
because the same code runs in pilot mode.
