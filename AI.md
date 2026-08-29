# AI architecture

## The principle

The chatbot is the interface. The product is patient story → structured clinical
context → physician preparation.

So the AI does only the parts where language understanding genuinely helps, and
deterministic code does everything else. That split is not a cost optimisation
first and a safety property second — it is both at once, and it is why this
product can be given away.

## Harvesting

Patients rarely answer the opening question with one fact. They say "itchy scaly
rash on both elbows for four months, hydrocortisone did nothing, my dad has
psoriasis" — which is six answers. An interview that then asks "where is it?" has
spent a question, annoyed the patient, and learned nothing.

`src/lib/interview/harvest.ts` reads the clauses of an answer that already cover
other slots and lets the planner skip those questions. It is deterministic and
deliberately conservative:

- It never invents a value; the stored value is the patient's own clause.
- Each signal takes **only its own words** — one clause satisfying three signals
  produces three different targeted values, not the same sentence three times.
- Facts it takes are marked `harvested`, so the brief can show that the patient
  volunteered it rather than being asked.
- A missed signal costs one question, which is cheap. A wrong claim silently
  drops a question a dermatologist needed, which is not — so the thresholds are
  set to miss rather than over-claim.

Where a question asks two things and the patient volunteered one, the fact is
marked `partial` and the interview asks a **narrowed follow-up** ("Since it
started, has it been getting better, worse, or staying about the same?") rather
than re-asking or going without.

Measured across the scenario library: mean questions 8.6 -> 7.4, and the case
where a patient states everything up front 9 -> 6.

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
| Non-answer suppression | "not sure" never becomes a fact, so no brief row or HPI line ever reads *Symptoms: Not sure* |
| Explicit absence | The HPI names what the intake did not establish, so a physician can tell "asked and answered no" from "never asked" |
| Repetition suppression | A patient who answers three questions identically produces one row, not three |

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

`scripts/cost.ts` measures it. It does not call the API — it builds the exact
payloads the product would send, counts their tokens, and applies the checked-in
pricing, so the number is reproducible and free to compute. Run it after any
prompt change.

Measured across the thirty-three-scenario library:

| | per completed intake |
| --- | --- |
| Model calls | 8.5 (7.5 turns + 1 composition) |
| Input tokens | ~7,240 |
| Output tokens | ~1,010 |
| **Cost at Haiku 4.5 rates** | **~$0.012** |
| p90 | ~$0.015 |
| Cheapest case (patient disengages early) | ~$0.004 |

Every call's real token usage is recorded on the intake
(`aiUsage.estimatedCostUsd`), shown at the bottom of each brief, and averaged at
`GET /api/metrics` — so this estimate is replaced by measurement as soon as there
is traffic.

Without an API key: **$0.00**, and the product still works.

### Monthly AI spend at volume

Default model, mean intake, no other variable cost (the store is in-process; a
pilot adds a database, see `PILOT_READINESS.md`).

| Intakes / month | AI spend |
| ---: | ---: |
| 100 | $1.23 |
| 1,000 | $12.29 |
| 10,000 | $122.93 |
| 100,000 | $1,229.33 |

100 dermatologists at 20 intakes a week is about 8,700 a month — **under $110 in
model spend**. Free is economically viable well past the scale that matters
before product-market fit.

Same volumes on a larger model, for reference: Sonnet 5 is roughly 2x, Opus 5
roughly 5x. Neither buys anything here — the guard rejects unfaithful output
regardless of which model produced it, and the deterministic fallback is the
same either way.

### Why the cost stays flat

- Structured state accumulates on the server; the model never rebuilds it.
- Only the **previous turn** is resent, not the growing transcript. This was
  three turns and is the single largest saving available: cutting it took mean
  input from 8,350 to 7,240 tokens.
- Extraction and question-phrasing share one call.
- Branching is deterministic, so no call is spent deciding what to ask.
- Harvesting cuts the number of turns outright — a patient who explains
  everything up front costs less, not more.
- No image is ever sent to a model.

### Prompt caching: measured, and rejected

The obvious optimisation is to cache the system prompt and tool schema, which
are byte-identical on every turn. It does not work here, and the reason is worth
recording so it does not get "fixed" later.

`claude-haiku-4-5` has a **4,096-token minimum cacheable prefix**. Shorter
prefixes silently do not cache — no error, just `cache_creation_input_tokens: 0`.
This product's prefix is 779 tokens: 367 for the interviewer system prompt, 412
for the tool schema.

Padding the prefix to reach the minimum makes it worse, not better:

| | tokens per intake |
| --- | ---: |
| Uncached prefix, 7.5 calls × 779 | 5,843 |
| Padded to 4,096 and cached (1.25x write + 0.1x reads) | 7,782 |

Revisit only if the prefix grows past 4K for its own reasons, or if the default
model changes to one with a lower minimum (Opus 5 is 512 tokens, Sonnet 5 is
1,024) — and re-measure rather than assuming.

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
| Flood of writes | Token bucket per intake, returning 429 with a plain-language message |
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
