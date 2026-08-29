# Pilot architecture

What has to be true, technically, to run AION Intake for **5–20 dermatologists
at 100–2,000 intakes a month**. PILOT_READINESS.md lists the gates that are
about contracts, policy, and clinical safety; this one is about the machine.

The headline: at that volume nothing here is hard. The risk is not scale, it
is durability and identity — the two things a single in-process map does not
have.

## The load, in absolute terms

2,000 intakes a month is **3 per hour** averaged, and dermatology arrives in
clinic-shaped bursts: a Monday morning might see 30 patients starting intakes
inside 20 minutes. So size for the burst, not the mean.

| Quantity | Pilot ceiling | Notes |
|---|---|---|
| Intakes / month | 2,000 | 20 dermatologists, ~100 each |
| Concurrent patients | ~30 | Waiting-room burst, not steady state |
| Turns per intake | 8–9 | Hard-capped at 9 |
| Writes per intake | ~12 | 9 turns + photos + edits + submit |
| Peak writes / second | < 1 | Even in the burst |
| Stored bytes / intake | ~1.5 MB | Almost entirely photos |
| Storage / month | ~3 GB | At 3 photos per intake |
| AI cost / month | $1.23–$24.61 | Measured; `npm run cost` |

A single small instance and a small managed Postgres covers this with two
orders of magnitude of headroom. Anyone proposing a queue, a cache tier, or
horizontal sharding for a pilot is solving a problem this product does not
have.

## What changes from the demo

Four things, in dependency order. **All four are now built** — this section
describes what was done and what is left, rather than a plan. PILOT_SETUP.md
is the operational guide.

### 1. The store becomes Postgres — BUILT

`src/lib/store/types.ts` is the interface; `memory.ts` and `sql.ts` are the two
adapters. Nothing above the store knows which one is running.

The two properties the in-memory version got for free are now bought
explicitly:

- **Atomic read-modify-write.** `withIntake()` opens a transaction and takes
  `SELECT … FOR UPDATE` on the intake row, so two requests for the same intake
  serialise in the database and a second web instance changes nothing. An
  optimistic `version` column backs it up: any future path that skips the lock
  fails loudly rather than overwriting silently. The demo's promise chain
  (`store/lock.ts`) is still used by the memory adapter and only by it — the
  two mechanisms cannot disagree because they are never both in play.
- **No cross-request leakage.** `tests/pilot-isolation.test.ts` attacks the
  practice boundary directly, and `tests/pilot-durability.test.ts` runs five
  concurrent writes to one intake and asserts all five land. Both run against
  real Postgres (PGlite — Postgres compiled to WebAssembly), so the locking
  semantics are the genuine ones rather than a fake that would agree with
  whatever the code does.

### 2. Photos move to object storage — BUILT

Demo photos are data URLs inside the record; pilot photos are not. The row
holds a key, the bytes live in object storage, and the two adapters are a
local filesystem (development, or a single instance on an encrypted volume)
and anything S3-compatible.

**No signed URLs**, which is a change from what this document originally
planned. A pre-signed URL is a bearer token for a photograph of someone's
skin — forwardable, cacheable and unrevokable — which is precisely the
property the patient-token work removed. Instead the server checks who is
asking and streams the bytes itself, and every read is audited. The cost is a
few hundred kilobytes through the application per brief, which at three
intakes an hour is nothing.

Keys carry 128 bits of randomness under a `practice/intake/` prefix, so
knowing an intake id does not let you construct one and a lifecycle rule can
target a single practice. Server-side EXIF rejection is unchanged
(`src/lib/photos.ts` inspects the actual bytes), so the privacy property does
not depend on the browser.

### 3. Identity replaces the token and the passphrase — BUILT

Clinicians get accounts, scrypt-hashed passwords and signed sessions carrying
their practice; the account is re-read on every request so disabling one takes
effect immediately. Patient links are 256 bits, stored only as a peppered
hash, expiring, revocable, and gated on a second factor the link does not
contain.

The architectural requirement held: neither the store nor the interview engine
knows anything about authentication. `requireClinician()` in
`src/lib/auth/guard.ts` is the single seam an OIDC provider replaces.

What is NOT built: MFA, session revocation short of disabling the account, and
an identity-provider integration. See SECURITY_REVIEW_PACKET.md.

### 4. Rate limiting becomes shared — NOT YET BUILT

`src/lib/ratelimit.ts` is an in-process token bucket keyed per intake token —
deliberately not per IP, because a waiting room is one NAT and per-IP limits
would throttle the second patient to arrive. In-process is correct for one
instance. Two instances need shared counters (Redis, or a Postgres table if
you would rather not add a dependency for a pilot).

## Deployment shape

```
        patients (mobile)          clinicians (desktop)
              │                            │
              ▼                            ▼
        ┌───────────────────────────────────────┐
        │   Next.js app — 1 instance, 2 for HA  │
        │   engine · guards · rate limit        │
        └───────────────┬───────────────────────┘
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
    Postgres      Object store    Anthropic API
    (intakes,     (photos,        (optional —
     audit log)    encrypted)      degrades to
                                   deterministic)
```

Two instances only for availability, not throughput — and note that going to
two is exactly what forces items 1 and 4 above. One instance with a fast
restart is a legitimate pilot choice; be deliberate about which you pick.

The model is the only external dependency, and it is optional by construction:
if it is slow, rate-limited, or absent, every stage falls back to the
deterministic path and the patient sees a normal interview. That is measured,
not asserted — see MODEL_EVAL.md.

## What we would watch

Instrumentation exists (`/api/metrics`, `src/lib/analytics.ts`) and logs
counts, timings, and identifiers — never patient text. For a pilot the numbers
that would actually change a decision:

- **Completion rate**, split by device. The product's whole claim is that
  patients finish before the visit; this is the number that falsifies it.
- **Questions to completion.** Budget is 9. If the real distribution sits at
  the cap, the harvesting is not working on real speech.
- **Clarify-list length and what is on it.** A list that is always full means
  the interview is not asking the right things.
- **Model fallback rate**, by reason. A rising guard-fallback rate is a safety
  signal, not a performance one.
- **Time from submit to clinician open.** If briefs are read after the visit,
  the wedge has failed regardless of quality.

## What we would deliberately not build

Scaling work the pilot cannot justify: read replicas, caching layers, queues
for the model calls, multi-region, autoscaling, streaming responses. At three
intakes an hour these add operational surface and hide nothing. Revisit when a
measured number says so — not before.
