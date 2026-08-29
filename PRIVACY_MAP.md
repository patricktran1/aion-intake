# Privacy map

Where a patient's information can be, in each mode. No marketing language: the
purpose of this document is to let someone decide whether they are comfortable,
and to give a security reviewer a map to attack.

---

## Demo mode

```
patient's browser
   │  answers, photographs
   ▼
Next.js process ──► process memory (a Map)
   │
   └──► stdout ── counts, timings, pathway names. No answers.
```

That is the whole diagram. Nothing is written to disk, nothing leaves the
process, and a restart empties it. The data is synthetic, so there is nothing
to protect — the reason to say so precisely is that the public demo at
aion-intake.vercel.app runs exactly this, and "where could PHI be" has the
answer **nowhere, because there is none, and no durable place to put it**.

Demo mode refuses to start if `DATABASE_URL` is set, so it cannot be pointed at
a pilot database by one stray environment variable.

---

## Pilot mode

```
patient's browser
   │  answers, photographs, date of birth (the second factor)
   ▼
┌──────────────────────────────────────────────────────────────┐
│ Next.js application                                          │
│   authorization · guards · sanitisation · audit              │
└───┬───────────────┬──────────────────┬───────────────────────┘
    │               │                  │
    ▼               ▼                  ▼
 Postgres      object store      model provider (OPTIONAL, off by default)
 ─────────     ────────────      ──────────────────────────────
 intake        photograph        one answer at a time
 messages      bytes             + the question it answers
 facts                           + one turn of transcript
 HPI draft                       NO name, NO date of birth,
 clinician                       NO photographs, NO clinician
   notes                           identity, NO practice name
 patient name
 date of birth
 audit events
    │
    ▼
 stdout / log aggregator
 ─────────────────────
 request ids, routes, statuses, durations, internal identifiers,
 error codes. NO answers, names, HPI text, photographs, or prompts.
```

### Where PHI exists in pilot mode

| Location | What | Encrypted | Retained |
|---|---|---|---|
| Postgres | Answers, facts, HPI, clinician notes, name, date of birth | At rest, by the provider | `AION_INTAKE_RETENTION_DAYS` |
| Object storage | Photographs | At rest (SSE requested explicitly) | `AION_PHOTO_RETENTION_DAYS` |
| Model provider | One answer per request, transiently | In transit | Per that provider's contract |
| Backups | Everything above | Provider-dependent | **Longer than the primary — see below** |

### Where it explicitly is not

- **Logs.** The logging layer allowlists which fields may carry a string at
  all, and drops anything that does not look like an identifier rather than
  truncating it — a truncated clinical sentence in a log is still a clinical
  sentence in a log.
- **Analytics.** Event properties are counts, enums, booleans and ids. Keys
  containing `text`, `answer`, `verbatim`, `name`, `dob` are dropped.
- **Audit events.** They record that an action happened to a resource, never
  what the resource says. Meta values over 64 characters are dropped as prose.
- **URLs.** The patient token is in the path, which means it can appear in a
  browser's history; that is the reason for the second factor and the expiry.
  No photograph is ever addressable by URL alone.
- **Error responses.** Every failure goes through a fixed taxonomy. A Postgres
  error, a provider response and a stack trace cannot reach a client.

### Backups are the quiet one

A retention policy that deletes from the primary database but not from
backups has not deleted anything. Point-in-time recovery windows and bucket
versioning both silently extend retention. Configure them inside the retention
period, or state plainly that the real retention is the backup window — but do
not claim the shorter number.

---

## The model provider boundary

The single question a practice will ask: **does our patients' text leave the
building?**

With `AION_MODEL_MODE=off`, or with no `ANTHROPIC_API_KEY` set: **no**. Not
"we do not store it" — no request is made. `tests/pilot-model-boundary.test.ts`
stubs `fetch`, runs a complete interview with a key present and the mode off,
and asserts zero outbound requests. `npm run pilot:check` reports the current
state in one line.

With the model enabled, what is sent per request:

| Sent | Not sent |
|---|---|
| The patient's answer to one question | Their name |
| The question it answers | Their date of birth |
| The slot and its facets | Any identifier of any kind |
| One prior turn of transcript | The rest of the conversation |
| For the HPI: age in years, the fact list, a photo **count** | Photograph bytes |
| | The clinician's identity |
| | The practice's name |

The HPI prompt takes `{ age, facts, photos }` — a number, a string, and a
count. There is no parameter through which a date of birth or an image could
reach the provider even by mistake, which is a stronger guarantee than a
policy of not putting them there.

If the model is enabled, a BAA with the provider is required before any real
patient. This is a contractual control, not a technical one; the technical
control is that the product works completely without it.

---

## Data minimisation

Every persisted field was challenged against: *would removing this stop us
delivering the brief?*

Removed: `Patient.pronouns`, which nothing read.

Kept, with the reason:

| Field | Why it cannot go |
|---|---|
| Name | The clinician has to know whose brief this is. |
| Date of birth | The patient's second factor, and a clinician orienting to a case. |
| Verbatim answers | The product's whole claim is provenance — every brief line traces to the patient's own words. Removing them makes the brief unauditable. |
| Messages | The patient reviews and corrects; a correction needs the original. |
| Photographs | The reason the visit is efficient. Retained on their own shorter clock. |

Not collected at all: contact details, address, insurance, referrer, any
identifier issued by anyone else, and any history beyond this one complaint.
The schema comment in `0001_initial.sql` names what stays out and why.
