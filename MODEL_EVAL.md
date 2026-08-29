# Model vs deterministic

AION Intake runs with or without a language model. This document is about
which parts of it the model actually earns.

## The honest state of this file

**No model numbers have been measured.** This repository has never had an
`ANTHROPIC_API_KEY` configured, so every figure below marked *unmeasured* is
exactly that. The harness to produce them is built, tested, and committed; it
needs a key and about a minute.

That distinction matters more than the numbers would. A document claiming the
model improves fidelity by some percentage, with nothing behind it, is worse
than one that says it does not know.

## The ablation

The model has three separable jobs. Before this pass they were one switch, so
the only measurable question was "model or no model" — which cannot tell you
which stage is carrying the value or which one is carrying the risk.

`AION_MODEL_MODE` now gates each stage:

| Mode | Facts extracted by | Question phrased by | HPI drafted by |
|---|---|---|---|
| `off` | engine | engine | engine |
| `facts` | model | engine | engine |
| `turn` | model | model | engine |
| `hpi` | engine | engine | model |
| `full` *(ships)* | model | model | model |

`off` is byte-identical to running with no key. An unrecognised value means
`full`, so a typo cannot quietly disable a safety path in production. Verified
in `tests/ablation.test.ts`.

Run the comparison:

```
npm run eval:ablate              # every mode a key allows
npm run eval:ablate off full     # just these two
```

It runs the 49 golden cases per mode and prints the dimensions side by side.
With no key it runs `off` alone and says the rest are unmeasured.

## Measured: the deterministic baseline

49 golden cases, `AION_MODEL_MODE=off`, no API key, no cost:

| Dimension | `off` |
|---|---|
| pathway_routing_accuracy | 100% |
| mean_questions | 7.69 (budget 9) |
| redundant_question_rate | 0% |
| hpi_guard_clean_rate | 100% |
| unsupported_numeric_claim_rate | 0% |
| completion_robustness | 100% |
| clarify_cap_adherence | 100% |
| case_pass_rate | 100% |

This is the floor, and it is a high one. The deterministic path completes
every interview, routes every opener correctly, never re-asks a settled
question, and cannot fabricate — not because it is careful but because it only
ever copies the patient's words. Anything the model adds has to beat this,
and anything it risks is measured against it.

## Unmeasured: what the model is expected to do

Predictions, recorded before measurement so the harness can contradict them:

- **`facts` should raise fidelity on messy input.** The deterministic
  extractor takes clauses; a model should better separate "the itch is worse at
  night but the redness is worse in the morning" into two facts. Expect
  movement on redundancy and clarify quality, not on routing.
- **`turn` should not move any dimension.** It only changes wording. If it
  moves `hpi_guard_clean_rate` or `unsupported_numeric_claim_rate`, the
  question guard is leaking and that is a safety finding, not a quality one.
- **`hpi` should improve readability, which this harness cannot score.** The
  dimensions can only confirm it does no harm — guard-clean stays at 1.00 and
  no unsupported numbers appear. Whether the prose is better than the
  deterministic composer's is a question for dermatologists, not for a metric.
- **The risk is one-directional.** Every deterministic dimension is already at
  its ceiling except question count, so the model has little room to help on
  these axes and real room to hurt. That asymmetry is why the guards fall back
  silently rather than surfacing model output on doubt.

## How the fallbacks bound the risk

The model is never trusted on its own output:

- A fact whose quoted verbatim is not in the answer is rejected.
- A restatement built from words the patient did not use is replaced by their
  words. Numbers are a hard fail — one fabricated digit rejects the whole
  restatement.
- A question that names a diagnosis, gives advice, reassures, or suggests a
  treatment reverts to the engine's own wording. The patient cannot tell.
- An HPI draft that trips the hallucination guard is discarded for the
  deterministic composition.

So `full` degrades toward `off` under failure rather than toward something
wrong. That is the property the ablation should confirm: modes should differ
in richness, never in safety.

## What to do when a key exists

1. `npm run eval:ablate` and paste the table into the section above, replacing
   *unmeasured* with real numbers and today's model id.
2. Check the predictions above against what happened. Write down which were
   wrong — that is the useful output, not the table.
3. If `turn` moves a safety dimension at all, stop and fix the question guard
   before shipping model phrasing.
4. Re-run `npm run cost` with real usage numbers replacing the character-based
   estimate.
