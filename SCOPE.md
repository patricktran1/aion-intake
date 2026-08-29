# Scope

AION Intake is one wedge, built well. This file exists so that scope creep has to
argue with something.

## In scope

- An adaptive pre-visit interview for a dermatology patient
- Four optimised complaint pathways — rash/dermatitis, lesion/spot of concern,
  acne, hair loss — plus a general fallback
- Text input, always; voice input where the browser supports it
- Up to three patient-supplied reference photographs
- A patient review-and-correct step before submission
- A clinician list of upcoming visits with completed intakes
- The pre-visit brief
- An editable draft HPI with copy-out
- A lightweight post-visit scratchpad (exam, assessment, plan, medications,
  follow-up) that produces a draft note with copy-out
- Synthetic demo data and a reset

## Explicitly out of scope

Not "later" as a euphemism for "soon". These are refusals.

- A complete EHR
- Billing
- Coding
- Revenue cycle management
- Patient scheduling
- Telehealth
- Autonomous diagnosis
- Autonomous treatment
- Autonomous prescribing
- E-prescribing
- Pathology management
- Lab integration
- Pharmacy integration
- Insurance eligibility
- Ambient room recording
- A longitudinal patient portal
- Patient messaging
- A large analytics dashboard
- AI image diagnosis
- Mohs workflow
- Enterprise health-system features

## Boundaries that are product decisions, not missing features

**No autonomous diagnosis, anywhere.** Not in the interview, not from the photos,
not in the brief, not in the HPI. The interview will not tell a patient what it
thinks their skin problem is, even if asked directly. Model-written questions are
checked against a guard that rejects opinion, reassurance, and diagnosis language
before a patient ever sees them.

**No image analysis.** Photos are checked for whether they are usable — file
type, size, dimensions, a crude sharpness proxy — and never for what they show.
"This looks a little blurry" is a statement about the photograph.

**No prescribing.** The physician can type a medication plan into the scratchpad
and it appears in the draft note. Nothing is transmitted to a pharmacy. See
`AI.md` for what real e-prescribing would require, and why it is not a v1
decision.

**No invented clinical content.** The draft HPI contains only what the patient
said. A negative the patient did not state is a fabrication, and the guard treats
it as one. See `AI.md`.

**No chart.** The post-visit scratchpad produces text to copy into the
physician's real record. AION Intake is not that record and does not try to be.

## The rule

If a feature would only make sense in a system that also does scheduling,
billing, or charting, it belongs to a different product. Prove the wedge first.
