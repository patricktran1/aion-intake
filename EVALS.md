# The evaluation lab

The interview is the product. This directory is how we know whether it works,
and how a future change proves it did not break it.

```
npm run eval            # golden + generated corpus, terminal scorecard
npm run eval:golden     # golden only — fast, hand-reviewed
npm run eval:write      # write evals/results/latest.{json,md}
npm run eval:baseline   # commit the current numbers as the baseline
npm run eval:gate       # exit 1 on regression (part of npm run verify)
npm run eval:ablate     # model-vs-deterministic (see MODEL_EVAL.md)
```

Everything runs offline in a couple of seconds with no API key. That is
deliberate: an evaluation you have to pay for is an evaluation you skip.

## Rule zero: evidence, not test count

A suite that only ever goes green measures nothing. Every check here earns its
place by being able to fail for a real reason — and several of them have. The
first golden run failed 12 of 46 cases and four of those were genuine engine
defects, not bad assertions. That is the bar: if a check has never plausibly
caught anything, it is decoration.

Two habits keep it honest:

- **Assertions are semantic, never transcript-literal.** A case asserts that
  the patient's "since Christmas" survives into the brief, not that the brief
  matches a fixed string. Rewording a question must not fail a single case;
  losing a patient's words must fail loudly.
- **Guards get mutation-pinned.** `tests/mutation-pins.test.ts` exists because
  an audit found guards whose deletion the entire suite tolerated. Each pin
  fails if one specific guard is removed. Adding a guard without a pin means
  the next person can delete it silently.

## What a case looks like

```ts
{
  id: "rash-contradiction-timeline",
  expectPathway: "rash",
  opening: "Itchy rash on both arms for two weeks",
  answers: { timeline: "Actually it has been about six months" },
  probes: "The patient corrected themselves. Both statements must survive.",
  assert: {
    mustPreserve: ["six months"],
    expectClarify: /timeline|how long/i,
    prohibited: [/assessment:/i],
  },
}
```

`answers` is keyed by slot id, so the case does not care what order the engine
asks in — only that when it asks about the timeline, this is what it hears.
An unlisted slot gets an empty answer, which is itself a useful signal: it
exercises the non-answer and disengagement paths.

Available assertions: `mustPreserve`, `prohibited`, `certainty`,
`expectClarify`, `maxQuestions`, `noRedundantQuestions`, `urgentFlag`,
`mustHaveFact`, `mustNotHaveFact`. Universal invariants (no crash, interview
finishes, guard clean, no empty or non-answer brief rows) apply to every case
without being declared.

## The dimensions

Reported separately, and never collapsed into one number — a single score
hides exactly the tradeoff you need to see, which is that asking fewer
questions and capturing more history pull against each other.

| Dimension | What it means | Gate |
|---|---|---|
| `pathway_routing_accuracy` | Right complaint family from the opener | ≥ 0.90 |
| `routing_robustness_typos` | Same, on deliberately mangled input (informational) | — |
| `mean_questions` | Average questions to completion (budget 9) | — |
| `redundant_question_rate` | Asking for something already settled | ≤ 0.05 |
| `hpi_guard_clean_rate` | Drafts with zero hallucination-guard violations | = 1.00 |
| `unsupported_numeric_claim_rate` | Numbers in the draft the patient never said | = 0.00 |
| `completion_robustness` | Interviews that terminate properly | = 1.00 |
| `clarify_cap_adherence` | Clarify list stays ≤ 6 items | = 1.00 |
| `case_pass_rate` | Cases with every assertion passing | ≥ 0.95 |

`mean_questions` has no gate on purpose. It is a tradeoff dial, not a
correctness property: a fix that captures a fact the engine was wrongly
skipping *should* raise it. Watch it move, and read the reason.

## Regression reporting

`npm run eval` prints each dimension against `evals/baseline.json` with an
arrow, so a change shows up as a delta rather than a wall of numbers. The gate
compares against fixed thresholds, not the baseline, so a slow slide across
several commits cannot ratchet the standard down.

Refresh the baseline (`npm run eval:baseline`) only when you have read the
diff and believe the new numbers. It is a commitment, not a formality.

## The corpora

- **Golden** (`evals/corpus/golden.ts`) — 49 hand-written, hand-reviewed cases.
  Each one exists because a specific thing can go wrong. See GOLDEN_SET.md.
- **Generated** (`evals/corpus/generated.ts`) — 240 cases from templates crossed
  with six input styles (plain, lowercase-no-punctuation, typos, run-on, terse,
  emoji) and three completeness levels. This is breadth: it catches the crash
  and the stuck interview, not the subtle fidelity bug.
- **Property** (`tests/property.test.ts`) — not a corpus but the same job from
  the other end: seeded random input asserting invariants rather than outcomes.

Typo-style generated cases assert `expectPathway: "any"`. The deterministic
router keys on keywords, and recovering "brekaing otu" is the model layer's
job, not the regex's. Pretending otherwise would have meant either a fake
passing number or eight permanently red cases; instead `routing_robustness_typos`
reports the real figure (80%) as information.

## Adding a case

1. Write it because something specific can break, and say what in `probes`.
2. Assert the minimum that captures it. Over-assertion is how a suite becomes
   a change-detector nobody trusts.
3. Run `npm run eval:golden`. If it fails, decide honestly whether the engine
   or your assertion is wrong — during this build it was the engine four times
   and the assertion five.
4. If it passes on the first run, check that it *can* fail: break the relevant
   code, confirm red, put it back.
