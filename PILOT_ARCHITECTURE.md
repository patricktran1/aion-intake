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

Four things, in dependency order.

### 1. The store becomes Postgres

`src/lib/store/index.ts` is eight functions and nothing else in the codebase
touches persistence. That boundary is the whole migration plan: implement the
eight against Postgres, delete the map.

Two properties the current implementation gets for free that the real one must
buy explicitly:

- **Atomic read-modify-write.** Every write route reads an intake, awaits, and
  saves. In-process this is made safe by `src/lib/store/lock.ts`, a per-intake
  promise chain. That construct does not survive a second instance. With
  Postgres, the equivalent is a row-level transaction (`SELECT … FOR UPDATE`)
  or an optimistic `version` column with a retry — pick one, and delete the
  lock file when you do rather than leaving two mechanisms that disagree.
- **No cross-request leakage.** Verified today by `tests/concurrency.test.ts`,
  which interleaves two patients turn-for-turn and asserts neither record
  contains the other's words. Port that test against the real store; it is the
  single most important test in the suite.

### 2. Photos move to object storage

Photos are data URLs inside the intake row today. At 1.5 MB per intake that is
tolerable for a pilot database but wrong in kind: it makes every read of an
intake drag megabytes, and it puts image bytes in backups that have different
retention needs from text.

Object storage with server-side encryption, short-lived signed URLs, and the
intake row holding only keys. Server-side EXIF rejection already exists
(`src/lib/photos.ts` inspects the actual bytes; an EXIF-bearing JPEG is
refused), so the privacy property does not depend on the browser.

### 3. Identity replaces the token and the passphrase

The intake token is 128 CSPRNG bits and is currently the entire patient
identity; the clinician side is one shared passphrase in middleware. Both are
demo constructs. PILOT_READINESS.md §3 and §4 own this; architecturally the
requirement is that neither the store nor the interview engine knows anything
about auth, and that stays true.

### 4. Rate limiting becomes shared

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
