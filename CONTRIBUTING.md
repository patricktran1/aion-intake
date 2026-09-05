# Contributing

Written for whoever picks this up next — a person or an agent. It assumes you
have read SCOPE.md, and it is mostly about the two things that are easy to get
wrong here: staying inside the wedge, and proving a change is safe.

## The wedge

**The patient arrives with the history already taken.**

That sentence decides what gets built. A dermatology visit starts with the
dermatologist typing what the patient could have told them before they walked
in; this product moves that work earlier and gives the clinician a brief, a
draft HPI, and a short list of what to clarify in person.

Not an EHR, billing, coding, scheduling, telehealth, e-prescribing, autonomous
diagnosis, or image analysis. SCOPE.md has the full list and the reasoning.
The most common failure mode for a change here is not a bug — it is a
reasonable-sounding feature that turns this into a worse version of a product
that already exists.

Two rules that follow, and are worth stating because they are load-bearing:

- **The system never diagnoses, treats, or advises.** Not in a question, not
  in a brief, not in an HPI, not in a reassuring aside. Guards enforce this
  (`src/lib/ai/guard.ts`) and mutation pins keep the guards alive.
- **Everything a clinician reads came from the patient.** The deterministic
  composer cannot invent by construction; model output is checked against the
  patient's own words and discarded on doubt.

## Before you push

```
npm run verify    # typecheck · lint · tests · build · eval gate
```

That is the gate. It runs offline and takes under a minute. Beyond it:

- `npm run eval` — full scorecard with deltas against the committed baseline
- `npm run eval:golden` — the 49 hand-reviewed cases, two seconds
- `npm run cost` — AI cost per intake and at volume
- `node scripts/qa.mjs` — browser QA against a running server
- `node scripts/perf-a11y.mjs` — performance and accessibility

## How to make a change believable

The suite is large (750+ tests, 49 golden cases, 240 generated, 120 fuzz
seeds), which makes green cheap and therefore not very informative on its own.
What makes a change credible here:

**Show the test failing first.** If you are fixing a defect, write the test,
watch it go red, then fix it. If you are adding a guard, delete the guard and
confirm something fails. `tests/mutation-pins.test.ts` exists because an audit
found guards the entire suite would tolerate the deletion of — that is the
failure mode to defend against, and the only defence is checking.

**Say what moved and why.** `npm run eval` prints deltas. `mean_questions`
rising is not automatically a regression — a fix that stops the engine wrongly
skipping a question *should* raise it. Read the arrow, then explain it.

**Prefer the deterministic path.** Every model call has a deterministic
fallback, and the fallback is what runs in evaluation, in CI, and any time
there is no key. A feature that only works with a model is a feature that is
usually off.

## Where things live

| Path | What it owns |
|---|---|
| `src/lib/interview/engine.ts` | Routing, slot planning, urgency, sanitization |
| `src/lib/interview/conduct.ts` | One turn: model call, fallbacks, merging, state |
| `src/lib/interview/harvest.ts` | Reading unasked answers out of what was volunteered |
| `src/lib/ai/guard.ts` | The hallucination and scope guards |
| `src/lib/ai/compose.ts` | Brief, headline, deterministic HPI |
| `src/lib/store/` | Persistence (one interface, two adapters) and the write lock |
| `evals/` | The evaluation lab — see EVALS.md |
| `tests/` | Unit, route, property, concurrency, mutation pins |

The store boundary is deliberately narrow: nothing outside `src/lib/store/`
touches persistence, which is what makes the Postgres migration in
PILOT_ARCHITECTURE.md a contained change. Keep it that way.

## Style

Match what is there. Specifically:

- **Comments explain why, not what.** The existing comments are mostly about
  clinical reasoning or an attack that motivated a line. A comment restating
  the code is noise; a comment saying "a waiting room is one NAT, so rate
  limit per intake and not per IP" is why the next person does not break it.
- **Patient-facing copy is plain and unhurried.** No clinical vocabulary, no
  urgency theatre, no cheerfulness at someone worried about a mole.
- **Synthetic data only.** Never commit anything resembling a real patient.
- **Never claim HIPAA compliance.** SECURITY.md is explicit about what is and
  is not true; keep it that way.

## The documents

README.md (start here) · SCOPE.md (what this is not) · PRODUCT.md · AI.md ·
SECURITY.md · THREAT_MODEL.md · EVALS.md · GOLDEN_SET.md · MODEL_EVAL.md ·
METRICS.md · PILOT_READINESS.md · PILOT_ARCHITECTURE.md · DEMO.md ·
DEFERRED.md (what was deliberately not built, and why).

If you defer something, put it in DEFERRED.md with the reason. A list of
deliberate omissions is more useful to the next person than a clean repository
that looks like nobody considered the alternative.
