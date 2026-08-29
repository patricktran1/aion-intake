# Pilot readiness

The path from this synthetic demo to one real dermatology practice seeing real
patients. Written to be short enough that someone actually reads it before
deciding.

**Where the product is today:** every safeguard that can be built in code is
built in. Nothing that requires a contract, a vendor, or a durable database
exists yet, because none of it can be tested without real users and all of it
costs money to keep running.

---

## Must have before a single real patient

Nine things. None optional, roughly in the order they have to happen.

### 1. Business Associate Agreements

Signed with every processor that will touch patient data: the host, the
database, the object store, and the model provider. Before collection, not
after. This gates everything below it, and it is the item most likely to take
longest.

### 2. Durable, encrypted storage

Today the store is one in-process map (`src/lib/store/index.ts`) that empties on
restart. A pilot needs managed Postgres with encryption at rest, least-privilege
credentials, and migrations under review.

The interface is eight functions and nothing else in the codebase touches
persistence, so this is a contained change — but it is also the point at which
the product stops being free to run.

### 3. Real clinician authentication

The shared passphrase in `src/middleware.ts` must be **removed, not extended**.
A pilot needs per-user identity with MFA, sessions with sane expiry, and a
distinction between the dermatologist and front-desk staff.

### 4. Real patient linking

Today the intake token *is* the identity: 128 bits from the platform CSPRNG,
and whoever holds the link can read and edit that intake. For real patients the
token must be bound to a specific scheduled visit, be single-use or
short-lived, carry a second factor such as date-of-birth confirmation, and be
revocable.

### 5. An audit log

Who opened which brief, when, and what they changed. Append-only, retained
separately from application logs. There is none today.

### 6. Photograph storage

Photos currently live as data URLs inside the intake record — fine for a demo,
wrong for production. They need object storage with server-side encryption and
short-lived signed URLs, plus server-side metadata stripping to back up the
client-side EXIF removal that already happens in the browser.

### 7. Retention and deletion, implemented

A defined lifetime for intake records and photographs, and a deletion path that
actually works for both patient and practice requests. Documenting a policy is
not implementing one.

### 8. Rate limiting that survives more than one instance

`src/lib/ratelimit.ts` is a per-process token bucket. On a serverless deployment
each instance keeps its own counters, so it makes casual abuse inconvenient and
nothing more. A pilot needs a shared limiter at the edge.

### 9. A security review by someone who did not write this

Plus a breach-response plan. Neither exists.

---

## Can wait until later

Things that sound urgent and are not, for one practice and a few hundred
patients.

| | Why it can wait |
| --- | --- |
| SSO / SAML | One practice has a handful of clinicians. Per-user auth with MFA is enough. |
| Role-based access beyond clinician vs staff | Two roles cover a small practice. |
| Multi-tenancy and per-practice data isolation | One pilot practice means one tenant. Design the schema so it is addable; do not build it. |
| EHR integration | Copy-paste is the integration. If physicians stop copying, that is the signal to build it — and the signal is instrumented. |
| Self-serve onboarding | The founder onboards the first ten practices personally. That is where the learning is. |
| SOC 2 | Necessary to sell to a health system, not to run one pilot under a BAA. |
| High availability, multi-region, autoscaling | A single small instance serves a practice comfortably. |
| A model-provider zero-retention agreement | Worth having, but the deterministic mode already runs the whole product without sending anything anywhere. Start the pilot there if the agreement is slow. |
| Patient-facing account recovery | There is no account. A new link replaces a lost one. |
| Formal penetration testing | After the review in item 9, before a second practice. |

---

## The cheapest honest pilot

If the goal is to learn whether dermatologists change their behaviour, the
minimum is smaller than it looks:

1. BAAs with the host and database provider.
2. Postgres with encryption at rest, plus object storage for photographs.
3. Per-user clinician auth with MFA.
4. Visit-bound, expiring intake tokens.
5. An audit log.
6. A written retention policy that the code enforces.
7. Someone else's security review.

**Run it in deterministic mode.** The interview, the brief, and the draft HPI all
work with no model configured, no patient text leaves the trust boundary, and
item 9's provider agreement stops being on the critical path. Turn the model on
later, once a BAA covers it, and measure whether the prose is worth the change.

Estimated fixed cost of that stack: tens of dollars a month, plus the legal time
for the agreements. The engineering is measured in weeks, not quarters — most of
it is item 2 and item 3.

---

## What does not change

These are properties of the product, not of the deployment, and they hold in a
pilot exactly as they hold in the demo:

- No autonomous diagnosis, anywhere, including when a patient asks directly.
- No image analysis of any kind.
- Nothing transmitted to a pharmacy.
- No clinical content in the draft HPI that the patient did not supply, enforced
  by a guard that falls back to deterministic output on any violation.
- No patient free text in analytics, enforced by test.

See `SECURITY.md` for what is true today and `SCOPE.md` for what this product
refuses to become.
