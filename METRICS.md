# Metrics

Instrumentation, not a dashboard. Everything below is emitted by
`src/lib/analytics/index.ts` and aggregated at `GET /api/metrics`. Building a
reporting UI on top of this would be scope creep (`SCOPE.md`).

## The four questions that decide whether the wedge is real

Page views are not among them.

**1. Can a patient finish comfortably in under five minutes?**
`median_completion_seconds`, `completion_rate`, `median_questions_asked`.
Target: median under 300 seconds, completion rate above 70%. A completion rate
that falls as question count rises means the budget is too generous.

**2. Can a dermatologist understand the story in under thirty seconds?**
Not directly measurable in software. The observable proxy is
`clinician_hpi_copied` — a physician who copies the HPI has decided the brief is
trustworthy. Target: above 50% of opened briefs.

**3. Does the dermatologist repeat fewer history questions in the room?**
The number this product exists for, and it cannot be instrumented. It has to be
observed in a clinic, by watching visits with and without an intake. Until
someone does that, everything else is a proxy.

**4. Is the draft HPI good enough to edit rather than rewrite?**
`clinician_hpi_edited` against `clinician_hpi_copied`. Editing is a *good* signal;
the goal is a high edit rate with a high copy rate. A high copy rate with almost
no edits may mean nobody is reading it carefully. Copies with no edits *and* no
subsequent note generation is the worrying pattern.

## Events

| Event | Where |
| --- | --- |
| `intake_opened` | Patient loads the link |
| `intake_started` | Patient taps Start |
| `intake_question_answered` | Each turn, with `slot`, `input_mode`, `empty`, `certainty` |
| `intake_photo_uploaded` / `intake_photo_rejected` | Photo step |
| `intake_review_edited` | Patient corrects a line on the review screen |
| `intake_submitted` | With `question_count`, `photo_count`, `voice_turns`, `duration_seconds`, `ai_cost_usd` |
| `intake_abandoned_resumed` | Patient returns to an unfinished intake |
| `clinician_list_viewed` | Visit list |
| `clinician_brief_opened` | Brief |
| `clinician_hpi_edited` / `clinician_hpi_copied` | HPI panel |
| `clinician_note_generated` / `clinician_note_copied` | Note panel |
| `ai_call` / `ai_fallback` | Every model call and every degradation, with reason |
| `demo_reset` | Demo reset |

## Derived numbers at `/api/metrics`

```
intakes_started, intakes_completed, completion_rate,
median_completion_seconds, median_questions_asked,
voice_turn_share, photos_uploaded, photos_rejected,
patient_review_edits,
clinician_briefs_opened, clinician_hpi_copied,
clinician_hpi_edited, clinician_notes_copied,
ai_calls, ai_fallbacks,
mean_ai_cost_per_completed_intake_usd,
ai_mode, model
```

## Cost

`mean_ai_cost_per_completed_intake_usd` is computed from real token counts
returned by the API, not from an estimate. It answers the only question that
decides whether this can stay free: what does one completed intake cost.

Expected: about $0.02 with a model configured, $0.00 without. See `AI.md`.

`ai_fallbacks` against `ai_calls` is the other cost-adjacent number — a rising
fallback rate means the model is being paid for and then discarded.

## What is deliberately not measured

No per-patient behavioural profile. No free text in analytics — `track()` drops
it, enforced by test. No third-party analytics vendor, so no health information
can reach one. No session recording. See `SECURITY.md`.
