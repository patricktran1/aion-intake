# The golden set

49 hand-written, hand-reviewed cases in `evals/corpus/golden.ts`. Each one is
here because a specific, nameable thing can go wrong. If you cannot say what a
case protects, it does not belong.

Run them: `npm run eval:golden`. Two seconds, no API key, no cost.

## Coverage by concern

| Family | Cases | The failure being watched for |
|---|---|---|
| Rash | 9 | Acute vs chronic vs intermittent; the info-dense opener that should collapse the interview; the vague opener that should not |
| Lesion | 8 | Change over time; bleeding; the cancer worry that is not a cancer history; a patient who calls everything a mole |
| Safety language | 7 | Urgent phrasing recognised; benign phrasing not escalated; a request for a diagnosis declined without a lecture |
| Temporal fidelity | 6 | "Since Christmas", "a while", "maybe a few months" — approximations must stay approximate |
| Medication fidelity | 5 | "Clobeta-something", "the blue tube" — a half-remembered drug is preserved, never resolved into a real one |
| Acne | 4 | Scarring and a deadline; adherence; not knowing what was used |
| Hair loss | 3 | Postpartum, patchy, receding — the pattern is the clinical question |
| General / fallback | 4 | Nails, itch with no rash, several concerns at once, sweating |
| Redundancy | 3 | Never re-ask what the opener already answered |
| Negative vs unknown | 3 | "No" and "I don't know" are different clinical facts and must stay different |
| Injection / abuse | 2 | Instructions inside an answer are patient text, not instructions |
| Language | 3 | Voice run-on, emoji, "I already told you that" |
| Contradiction | 2 | A patient correcting themselves — both statements survive, the clinician is told |

Tags on each case make slices runnable; the counts above are the reason each
slice exists.

## What "hand-reviewed" means

Every case was read as a dermatologist would read the output it produces, and
the assertions were written from that reading — not from whatever the engine
happened to emit. This distinction is the whole value of the set. Nine cases
changed during review:

- **Four found real engine defects.** Vague treatment language was being
  harvested as a named treatment; "melanoma" in an opener was being filed as
  sun history; "I might hurt myself" was not being flagged; the
  multiple-concerns flag was swallowed on the sparse-answer path.
- **Five found over-strict assertions of mine.** A patient's own "is this
  melanoma" phrasing is legal to preserve. A prior clinician's "probably
  nothing" is theirs and should be quoted. "Since Christmas" landing as
  approximate rather than stated is a judgment call, not an error.

Getting that split wrong in either direction is how an eval suite goes bad:
loosen every failing assertion and it measures nothing; force the engine to
satisfy every assertion and it learns your mistakes.

## Conventions

- **Semantic assertions only.** `mustPreserve: ["six months"]` — never a
  full-transcript match. Rewording a question must not fail a case.
- **Answers keyed by slot, not turn.** A case does not encode question order,
  so reordering the plan is not a breaking change.
- **Omitted slots answer empty.** That is free coverage of the non-answer and
  disengagement paths, and it is why some cases legitimately end early.
- **`probes` is required prose.** One sentence saying what this case is for.
  It is the first thing a future reader needs and the last thing anyone
  remembers to write.

## When a golden case fails

Assume the engine is right until you have read the actual output. During this
build the failures split four-to-five between real defects and bad
assertions — near even odds. Reproduce the case, read the brief and HPI it
produces, and ask what a dermatologist would think. Then fix the side that is
actually wrong.

Never fix a golden failure by loosening the assertion to match new behaviour
unless you can explain, in the case's `probes`, why the new behaviour is
correct.
