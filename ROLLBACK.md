# Rollback and migration safety

How to get from a broken deploy back to a working one, and how to write
migrations so that path always exists.

---

## The rule that makes rollback possible

**A deploy must run against both the old schema and the new one.** If version
N+1 ships a migration that version N cannot tolerate, rolling back the app
means rolling back the database too — and a database rollback loses every write
made since the deploy. That is the situation to design out, not to plan for.

So migrations are **expand-only within a release**. A column or table is added
in one release and only removed a release later, after all running code has
stopped using it. The four-step shape:

```
1. ADD          migration adds the new column/table (nullable, or with a default)
2. DEPLOY       new code writes AND reads it; old code ignores it
3. BACKFILL     a migration or script fills existing rows, if needed
4. REMOVE       a LATER release drops the old column, once nothing reads it
```

A destructive single-step change (rename, drop, tighten a constraint in the
same release that starts depending on it) makes the app un-rollbackable for the
window it is live. Do the two-phase version instead. The only exception is a
migration to a table no released code has ever touched — a brand-new table in
the same release that introduces it is safe, because rolling back the app just
stops using it.

---

## Rolling back the application

The app is stateless apart from the database and object storage, so an app
rollback is a redeploy of the previous build.

1. **Redeploy the previous version.** On the platform, this is redeploying the
   prior build/image, or `git revert` + deploy. Do not delete data.
2. **Leave the schema alone.** Because migrations are expand-only, the previous
   app version runs against the current schema. Do not "roll back the
   migration" to match — that is the move that loses data.
3. **Verify:** `/api/health` green, a clinician can open a brief, a patient
   link resolves, a test intake submits.
4. Diagnose the bad version on a scratch environment.

Rolling back is the fast path. Reach for it before deep diagnosis when
production is visibly broken.

---

## When a migration itself is the problem

- A migration that **failed** rolled back — each runs in its own transaction.
  The schema is whatever it was before. Re-running `npm run db:migrate` is
  safe.
- A migration that **applied but was wrong**: do not edit the committed file.
  The checksum guard will refuse to run once a recorded migration's file
  changes, which is correct — it means the database and the repository disagree.
  Write a **new** migration that corrects it, and deploy that. Forward, never
  sideways.
- Concurrent instances starting at once cannot both migrate: an advisory lock
  serialises them, so the second waits and then finds nothing to do.

---

## Restoring the database (last resort)

Only when data is actually lost or corrupted, not for a code regression.

1. Restore Postgres from the provider's point-in-time recovery to just before
   the incident.
2. **Reconcile object storage to the same point.** A database restored to an
   earlier point references photo keys; objects deleted after that point are
   gone, and objects created after it are now orphans. See BACKUP in
   PILOT_SETUP.md — restore both to the same timestamp, or accept and document
   the drift (some briefs show a broken photo; some objects are unreferenced).
3. Run `npm run pilot:check` and a smoke intake before returning to service.

Rehearse this once, on synthetic data, before the pilot starts. The
`backup:test` / `restore:test` commands do exactly that locally.

---

## Checklist for every migration PR

- [ ] Expand-only? (adds, does not destructively change what live code uses)
- [ ] Old app version still runs against this schema?
- [ ] New columns nullable or defaulted, so the ADD does not block on a big table?
- [ ] Backfill, if any, is a separate step that can run while the app serves?
- [ ] Any removal is of something no released code reads any more?
- [ ] Ran `npm run db:migrate` from zero and against a one-behind database?
