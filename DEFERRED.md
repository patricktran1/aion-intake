# Deferred

Ideas that came up during building and were deliberately not built. Kept here so
they stop being rediscovered, and so the reason survives longer than the memory
of the decision.

`SCOPE.md` holds the outright refusals — the EHR, billing, scheduling,
telehealth, e-prescribing, AI image diagnosis. This file is different: these are
things that would genuinely help, at the wrong time.

---

## Would help the patient

**Resume by SMS.** A patient who abandons intake gets nothing. A single reminder
with their link would probably lift completion more than any interview change.
Needs a messaging vendor, a BAA, and consent handling — all of it before there is
evidence that abandonment is the problem. Instrument first: `intake_started`
minus `intake_submitted` already tells us the size of the prize.

**Spanish, and then more.** The interview is English-only. Every question lives
in one file (`src/lib/interview/slots.ts`), so translation is tractable, but
translated *medical* phrasing needs a clinician reviewer per language, and the
guard's vocabulary lists are English. Real, and not a v1.

**Voice output.** Reading the questions aloud would help patients who struggle
with text. Voice input already works; output is a different engineering problem
and a different accessibility claim, and screen readers already handle it.

**Save and resume across devices.** The link works anywhere, but a patient who
starts on a laptop and finishes on a phone has to find the link again.

**A "not sure, ask me at the visit" button.** Currently that is "Skip this one",
which reads as failure. Framing it as a deliberate choice might get better data
about what patients genuinely do not know. Cheap to build, worth testing after
there is real completion data to compare against.

## Would help the dermatologist

**Practice-configurable questions.** Every practice asks something slightly
different. The slot definitions are data, so this is mostly a UI problem — but
letting practices edit the interview before we know which questions earn their
place would freeze in whatever the first practice happened to prefer.

**A daily digest.** "Three briefs ready for tomorrow." Needs email, which needs a
BAA, and the clinician already opens the list.

**Print / PDF export of the brief.** There is a print stylesheet and nothing
more. A physician who wants paper can print the page. A proper export is a small
job that should wait until someone asks twice.

**Trend across visits.** "This is the third time she has come in for this." Genuinely
useful, and the first step onto the longitudinal-record path that `SCOPE.md`
refuses. Deferred with prejudice.

**Structured problem list output.** Codes, not prose. That is coding, which is
out of scope, and it would make the tool look like a billing product.

## Would help the engine

**Learning which questions get answered.** Every slot is instrumented — we know
which ones get skipped and which get hedged. Feeding that back to reorder or
retire questions is the obvious next move, and it needs real traffic to be
anything other than overfitting to thirty-three synthetic scenarios.

**Model-assisted harvesting.** Harvesting is regex over an answer. A model would
catch more, at a cost per turn and with a new fabrication surface to guard. The
deterministic version already cut the mean interview from 8.6 questions to 7.4;
measure the residual before paying for it.

**More pathways.** Nails, rosacea, hidradenitis, paediatric. The general fallback
handles them acceptably, and four well-tuned pathways plus a sensible default
beats nine mediocre ones. Add the fifth when the data says which fifth.

**Two-pass HPI.** Draft, then critique, then revise. Better prose, double the
cost, and the guard already catches the failures that matter.

## Would help operations

**Prompt caching.** Examined and rejected on measurement, not principle. Haiku
4.5 has a 4,096-token minimum cacheable prefix; this product's system prompt
plus tool schema is 779 tokens. Padding to reach the minimum costs 7,782 tokens
per intake against 5,843 uncached — 33% worse. Revisit only if the prefix grows
past 4K for its own reasons, or if the default model changes to one with a lower
minimum. Details in `AI.md`.

**Batching extraction to submission time.** One extraction call over the whole
transcript instead of one per turn would cut roughly a fifth of the cost. It
also weakens the per-answer verbatim-grounding check, which is the control that
makes the brief trustworthy. Not worth $0.003 an intake.

**A real analytics vendor.** The current ring buffer loses everything on restart.
A vendor means health information leaving the trust boundary, which is precisely
what the current design avoids. When the numbers need to survive, they should go
to the same database as everything else.

**A metrics dashboard.** `/api/metrics` returns JSON. A founder reading JSON for
the first hundred practices is fine, and `SCOPE.md` explicitly refuses the
analytics suite.

**Multi-region, autoscaling, queues.** Build for the next hundred physicians.

---

## The test

Before any of this gets built, it has to answer: *does this make a dermatologist
more likely to use the product tomorrow?* Most of the list does not. The ones
that might — SMS resume, learning from skipped questions, the fifth pathway —
all need real traffic to evaluate, which is the argument for shipping the pilot
in `PILOT_READINESS.md` rather than building any of them now.
