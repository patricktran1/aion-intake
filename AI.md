# AI architecture

## The principle

The chatbot is the interface. The product is patient story → structured clinical
context → physician preparation.

So the AI does only the parts where language understanding genuinely helps, and
deterministic code does everything else. That split is not a cost optimisation
first and a safety property second — it is both at once, and it is why this
product can be given away.

## What is deterministic

Written in code, testable, free, and identical every time:

- **Pathway selection.** Weighted pattern matching over the opening answer picks
  one of five intake routes (`src/lib/interview/engine.ts`). A pathway is not a
  diagnosis; it decides which questions get asked.
- **Which question comes next.** A slot planner walks the pathway's clinically
  ordered slot list, skips what is already answered, drops optional questions
  under budget pressure, and always reserves the last question for the patient's
  own goal (`planNextQuestion`).
- **The question budget.** Nine questions, opener included. Hard ceiling.
- **Certainty classification.** Hedges ("I think", "around", "maybe") mark a fact
  approximate; non-answers mark it unclear.
- **The pre-visit brief.** Assembled from filled slots. Empty sections are
  dropped rather than filled with "none reported".
- **"Clarify in visit".** Computed from skipped questions, hedged answers, and
  core slots the budget never reached.
- **The draft note.** Patient history and clinician findings concatenated into
  labelled blocks. No model touches it.
- **Everything, when no API key is set.** The product runs end to end on the
  deterministic engine alone, at zero AI cost. That is the default in this
  repository.

## What the model does

Two call sites. Both in `src/lib/interview/conduct.ts`.

### 1. One call per patient turn

Extracts structured facts from the answer **and** re-voices the next question, in
a single round trip — round trips are the cost.

- Tool-use with a strict schema (`TURN_TOOL` in `src/lib/ai/prompts.ts`).
- Context sent: the question just asked, its target slot, the answer, the next
  engine-selected question, and the last three turns. Never the whole transcript.
- The model may re-voice the next question so it flows from what the patient
  said. It may not change what the question is about.

### 2. One call at submission

Rewrites the draft HPI into prose. The deterministic HPI is generated first and
is the guaranteed output; the model result is an upgrade that has to earn its
place.

## Hallucination controls

Layered, and each one is independently tested (`tests/guard.test.ts`,
`tests/compose.test.ts`, `tests/conduct.test.ts`).

| Control | What it stops |
| --- | --- |
| Slot allowlist in `parseTurn` | A fact attributed to a question that was never asked |
| Verbatim grounding | A quote the patient did not say — if the quoted substring is not in the answer, it is replaced with the answer itself |
| Certainty enum validation | An invented confidence level; invalid values drop the fact entirely |
| `guardNarrative` | Invented negatives ("denies fever", "NKDA"), examination findings, assessment and plan language, and dates or measurements the patient never gave |
| `guardDiagnosisTerms` | A diagnosis name the summary introduced. A diagnosis the *patient* used ("I had eczema as a kid") is allowed through |
| `acceptOrFallbackHpi` | Any violation at all sends the deterministic HPI instead |
| `isSafeQuestion` | A model-phrased question containing advice, reassurance, or an opinion about the condition reverts to the engine's own wording |
| Certainty carried into prose | "I think around May" renders as *Started around May (patient's approximation)*, never as a date |

The physician can see the difference for themselves: **Show patient's own words**
on the brief reveals the verbatim source under every line.

## Prompts

All prompts live in `src/lib/ai/prompts.ts` and carry `PROMPT_VERSION`. None are
inlined in components or route handlers. A change in output quality can be traced
to a change in wording.

## Cost model

One small model for everything: `claude-haiku-4-5` by default, configurable via
`AION_MODEL`. Pricing is checked into `src/lib/ai/cost.ts` so a rate change is a
visible diff.

Measured per completed intake, with a model configured:

| | Input tokens | Output tokens |
| --- | --- | --- |
| 8 turn calls | ~9,000 | ~1,600 |
| 1 HPI call | ~800 | ~250 |
| **Total** | **~9,800** | **~1,850** |

At Haiku pricing ($1 / $5 per million tokens): **roughly $0.02 per completed
intake.** Every call's real token usage is recorded on the intake
(`aiUsage.estimatedCostUsd`), surfaced at the bottom of each brief, and averaged
at `GET /api/metrics` — so this estimate gets replaced by measurement as soon as
there is traffic.

Without an API key: **$0.00**, and the product still works.

What that means for giving it away: 100 dermatologists at 20 intakes a week is
about 8,700 intakes a month, or **under $200/month in model spend**. Free is
economically viable at the scale that matters before product-market fit.

### Why the cost stays flat

- Structured state accumulates on the server; the model never rebuilds it.
- Only the last three turns are resent, not the growing transcript.
- Extraction and question-phrasing share one call.
- Branching is deterministic, so no call is spent deciding what to ask.
- No image is ever sent to a model.

## Failure modes

Every one of these degrades to something the patient does not notice:

| Failure | Behaviour |
| --- | --- |
| No API key | Deterministic engine handles the whole intake |
| Model timeout or error | Deterministic extraction and engine phrasing for that turn |
| Malformed structured output | `parseTurn` returns null; deterministic path taken; `ai_fallback` recorded |
| Facts fail validation | Dropped individually; the answer is still stored verbatim |
| Unsafe generated question | Engine's own wording used instead |
| HPI fails the guard | Deterministic HPI shipped; violation count recorded |
| Empty answer | Treated as a skip and surfaced to the physician as "patient skipped this" |
| Unrecognised complaint | General dermatology pathway |
| Network drop mid-intake | Answers already saved; the same link resumes where they left off |
| Duplicate submit | Idempotent; no second intake, original timestamp preserved |
| Microphone unsupported | The button does not appear; typing is unaffected |

## Deferred: e-prescribing

Real electronic prescribing needs EPCS credentialing, an SPI-registered
prescriber directory, a certified transmission network, DEA-compliant two-factor
authentication, controlled-substance workflow, and state-level PDMP integration.
That is a company, not a feature, and building it before the wedge is proven
would be a category error.

The UX is nonetheless shaped for it: medications are already a distinct field in
the clinician scratchpad rather than free text buried in the plan, so a future
prescribing surface has somewhere to attach. Today that field is rendered into the
draft note and transmitted nowhere.
