# Runbook

What to do when something breaks during a pilot. Concrete actions, not theory.
Assumes the pilot architecture in PILOT_SETUP.md: one or two app instances,
managed Postgres, a private S3-compatible bucket.

The first move for almost everything is the same: **check `/api/health`** and
the structured logs (filter by the `request_id` a user reports). Every log line
carries a request id and no patient content, so you can trace an incident
without reading anyone's history.

---

## Database unavailable

**Symptom:** `/api/health` returns 503 with `checks.database: false`. Patients
see "We couldn't save that just now" (a retryable 503). Clinician list is empty
or errors.

**What is happening:** the app cannot reach Postgres. Nothing is lost — writes
that could not commit simply did not, and the patient is told to retry.

1. Confirm with the provider's status page and dashboard. Is it the primary, a
   failover, or a connection-limit exhaustion?
2. If connections are exhausted: the app pool is `max: 10` per instance. Check
   for a stuck long transaction (`SELECT * FROM pg_stat_activity WHERE state <>
   'idle' ORDER BY xact_start;`) and terminate it if it is wedged.
3. If the instance is down: fail over per the provider's runbook. The app
   reconnects on its own — no restart needed.
4. Once `/api/health` is green, spot-check: sign in as a clinician, open a
   brief, confirm a patient link resolves.

**Do not** point the app at a restored-from-backup database without also
reconciling object storage — see *Deletion failure* and BACKUP in PILOT_SETUP.

---

## Object storage unavailable

**Symptom:** photo uploads fail with a retryable 503; existing briefs load but
photos 404. `/api/health` stays **green** — object storage is deliberately not
a liveness dependency, because a patient can still complete an intake without a
photo.

1. Confirm with the provider. Bucket reachable? Credentials still valid?
2. Patients can finish their intake; only photos are affected. This is a
   degraded state, not an outage. Do not take the app out of rotation.
3. If credentials rotated unexpectedly, see *Accidental secret rotation*.
4. When restored, no backfill is needed — the metadata rows already point at
   the keys, and the objects reappear with the bucket.

---

## Auth provider unavailable

Local password accounts have no external auth provider, so this applies only
if OIDC has been wired in. If it has and it is down: clinicians already holding
a valid session cookie keep working for up to its 12-hour life; new sign-ins
fail. Patients are unaffected — they authenticate by token, not through the
clinician auth path. Wait it out or fail over the provider; nothing in the app
needs changing.

---

## Model provider unavailable

**Symptom:** nothing visible. This is the point of the architecture.

The interview, the brief, the HPI and every safety boundary run
deterministically. If the model is slow, rate-limited, or down, each stage
falls back to its deterministic path and the patient sees a normal interview.
Confirm with `AION_MODEL_MODE=off` in a scratch environment if you want to see
the fallback explicitly; in production, a rising `ai_fallback` rate in metrics
is the only symptom and needs no action.

If you want to stop calling the provider entirely (cost, an incident on their
side, a BAA question): set `AION_MODEL_MODE=off` and redeploy. No data changes.

---

## Deployment regression

**Symptom:** a new deploy is misbehaving — errors, a broken screen, wrong
behaviour.

1. **Roll back the application first** (see ROLLBACK.md). It is faster than
   diagnosing, and the migration discipline is designed so that the previous
   app version still runs against the current schema.
2. Then diagnose on a scratch environment, not in production.
3. If the regression is a broken CSP or a broken client bundle, browser QA
   (`node scripts/qa.mjs`) reproduces it in a minute — it has caught exactly
   this before.

---

## Bad migration

**Symptom:** a deploy's migration step failed, or the app reports schema issues.
`/api/health` may show `checks.schema: false`.

1. Migrations run in a transaction each and take an advisory lock, so a failed
   migration **rolled back** — the schema is whatever it was before that
   migration, not half-applied. `npm run db:migrate` is safe to re-run.
2. If a migration is genuinely wrong (not just a transient failure), do **not**
   edit the committed migration file — the checksum guard will then refuse to
   run, loudly, which is correct. Write a new migration that corrects it and
   deploy that.
3. If the app is already live against the old schema and the new migration
   cannot apply, the old app version keeps serving (that is what the two-phase
   migration discipline in ROLLBACK.md buys). Fix forward with a new migration.

---

## Accidental secret rotation

**`AION_TOKEN_PEPPER` rotated:** every outstanding patient link is now
invalid — the stored hashes no longer match. This is the *intended* emergency
lever, but if it was an accident: restore the previous pepper value and the
links work again. If it was deliberate (a suspected leak), reissue links to
patients with upcoming visits; there is no way to recover the old links, by
design.

**`AION_SESSION_SECRET` rotated:** every clinician session cookie is now
invalid; clinicians must sign in again. No data is affected. If accidental,
restore the previous value.

**Database or object-storage credentials rotated:** update the environment and
redeploy. The app has no cached credentials beyond the connection pool, which
rebuilds on restart.

Keep the previous value of each secret recoverable for exactly this reason.

---

## Deletion failure

**Symptom:** a retention run or a delete errored partway, or a photo 404s but
its row is still present (or vice versa).

Deletion is designed to converge to *gone*, so the fix is almost always **run
it again**:

1. `npm run pilot:retention` (dry run) shows what is still due.
2. `npm run pilot:retention -- --apply` re-runs. Row deletion cascades; object
   deletion is idempotent (a missing object is not an error). A second run
   cleans up whatever the first left.
3. For a specific intake: deleting it again is a no-op if it is already gone,
   and completes the deletion if it was partial.
4. To find orphaned objects (an object whose row is gone): list the bucket
   prefix for the practice and compare against `SELECT object_key FROM photos`.
   Anything in the bucket not in the table is an orphan and can be deleted.

The one thing that survives deletion by design is the audit event recording
that the deletion happened. That is correct — it carries no clinical content.

---

## Suspected cross-tenant access

**Symptom:** a report or a log line suggesting one practice saw another's data.

This should be impossible — every clinician query carries `practice_id` in its
WHERE clause, and `tests/pilot-isolation.test.ts` proves it — but treat any
report seriously.

1. **Preserve the audit log.** `SELECT * FROM audit_events WHERE practice_id =
   $suspect ORDER BY at DESC` — every brief open, photo access and edit is
   there, with actor and timestamp.
2. Identify the request: the reporter's `request_id` ties their session to
   exact log lines and audit rows.
3. Confirm the actor's session practice against the account's practice. A
   mismatch is refused by `requireClinician` and would appear as an
   `authz.denied` audit event, not a successful read.
4. If a real cross-tenant read occurred, it is a code defect in a query that
   dropped its practice filter. Find it (grep for `bundleById` used where
   `bundleForClinician` should be), fix it, add it to the isolation suite, and
   rotate nothing — this is not a credential compromise.
5. Notify per the breach procedure (external, see PILOT_READINESS.md).

---

## Escalation

Anything not covered here, or any suspected exposure of real patient data:
stop, preserve logs and the audit table, and escalate to the responsible
engineer and the practice per the agreed contact path. Do not attempt a
database surgery you are unsure of under pressure — the app failing closed is
safer than a well-intentioned manual write.
