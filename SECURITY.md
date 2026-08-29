# Security and privacy

## Status

**This build holds synthetic data only. It is not HIPAA compliant and does not
claim to be.** A medical-looking interface is not a compliance posture. This file
records what is actually true today, and what has to become true before a single
real patient uses it.

## What is true today

### Data handling

- All patient data in this repository is synthetic and generated in
  `src/lib/demo/seed.ts`. There is no real patient information, and no fixture
  contains anything shaped like a real identifier.
- Storage is a single in-process map (`src/lib/store/index.ts`). Nothing is
  written to disk, and everything is discarded when the process restarts. That is
  a deliberate pre-product-market-fit choice: zero infrastructure, zero fixed
  cost, and nothing durable to leak.
- The store sits behind a narrow interface. Swapping it for a real database means
  implementing eight functions; nothing else in the codebase touches persistence.

### Photographs

- Images are downscaled and re-encoded through a canvas **in the browser** before
  upload. Re-encoding discards all EXIF metadata, including GPS coordinates,
  before the image leaves the device.
- Maximum three per intake, 6 MB, minimum 400px on the short edge.
- Photos are never sent to any model, and no image analysis of any kind is
  performed.
- Quality checks are advisory and non-blocking. A patient is never prevented from
  submitting a photo they want the dermatologist to see.

### Analytics and logging

- Analytics is a local ring buffer plus structured stdout
  (`src/lib/analytics/index.ts`). There is no third-party analytics vendor, so
  health information cannot reach one.
- `track()` allowlists property key shapes and drops anything whose key contains
  `text`, `answer`, `verbatim`, `name`, `email`, `dob`, or `photo_data`. Values
  are truncated and non-primitives are discarded. This is enforced by test.
- Only ids, counts, durations, enums, and booleans are ever recorded. Patient
  free text is never logged.
- The browser can report only three specific events, on an allowlist, with no
  free text (`/api/analytics`).

### Access control

- **Patient:** the intake link is a bearer credential — 128 bits from the
  platform CSPRNG (`crypto.getRandomValues`). Knowing the link is the only
  authentication. There is no account, no password, and no session.
- **Clinician:** optional shared passphrase via `CLINICIAN_ACCESS_CODE`,
  enforced in `src/middleware.ts` over `/clinician`, `/api/clinician`, and
  `/api/metrics`, with a constant-time comparison and an httpOnly cookie. Unset
  by default, which leaves the demo open. **A shared passphrase is not
  authentication and is not presented as such.**
- The clinician API cannot overwrite patient-supplied facts. Only the HPI and the
  review fields are writable from that side, so provenance in the brief stays
  true. Enforced by test.

### AI provider data flow

- With no `ANTHROPIC_API_KEY`, no data leaves the process at all.
- With a key, patient answers are sent to the Anthropic API for extraction and
  drafting. Nothing else is: no names, no dates of birth, no photographs, no
  practice identifiers.
- Prompts are centralised and versioned in `src/lib/ai/prompts.ts`, so exactly
  what is transmitted is auditable in one file.

### Transport

- Vercel terminates TLS and redirects HTTP to HTTPS by default. There is no
  in-repo mechanism that would downgrade it.
- The clinician cookie is `httpOnly`, `sameSite=lax`, and `secure` over HTTPS.

### Deletion and retention

- Everything is discarded on process restart, and `POST /api/demo/reset` returns
  the store to its seeded state.
- There is no patient-initiated deletion, because there is no durable storage to
  delete from. That changes the moment a database is introduced.

## Required before any real patient data

Non-negotiable, in roughly the order they have to happen.

1. **A signed Business Associate Agreement** with every processor in the path —
   the host, the database, and the model provider — before a single real answer
   is collected.
2. **Durable, encrypted storage.** Managed Postgres with encryption at rest,
   least-privilege credentials, and audited migrations. Photographs move to
   object storage with server-side encryption and short-lived signed URLs, not
   data URLs in a record.
3. **Real clinician authentication.** Per-user identity with MFA, sessions with
   sane expiry, and role separation between clinician and staff. The shared
   passphrase must be removed, not extended.
4. **Real patient linking.** Today the token *is* the identity. A real deployment
   needs the token bound to a scheduled visit, single-use or short-lived, with a
   second factor such as date of birth confirmation, and revocation.
5. **An audit log.** Who opened which brief, when, and what they changed —
   append-only, retained, and separate from application logs.
6. **A retention and deletion policy**, implemented rather than documented, with a
   defined lifetime for intake records and photographs and a working deletion
   path for both patient and practice requests.
7. **Rate limiting and abuse controls** on the intake endpoints. There are none
   today; the in-memory store makes brute-forcing tokens cheap for an attacker
   and expensive for the process.
8. **Secret management.** `ANTHROPIC_API_KEY` and `CLINICIAN_ACCESS_CODE` are
   read from the environment and are never rendered into the client bundle or
   logged. A real deployment needs a managed secret store and rotation.
9. **A model provider data agreement** covering training exclusion and retention,
   or a deployment in which patient text never leaves the trust boundary.
10. **Breach response and a security review** by someone who did not write this
    code.

## Known limitations

Stated plainly rather than buried.

- Anyone holding an intake link can read and edit that intake. There is no
  additional check.
- With `CLINICIAN_ACCESS_CODE` unset, the clinician view is public.
- There is no audit trail.
- There is no rate limiting.
- The in-memory store means a serverless deployment can serve a submitted intake
  from one instance and a stale view from another. Acceptable for a synthetic
  demo, disqualifying for anything real. The seeded demo patients are always
  present on every instance, so the demo remains coherent.
- Photographs live as data URLs inside the intake record, which is convenient for
  a demo and wrong for production.
- Client-side EXIF stripping depends on the browser's canvas implementation. A
  production path should also strip metadata server-side.

## Reporting

This is a pre-product-market-fit demo with no real users and no bug bounty. If
you find something, open an issue.
