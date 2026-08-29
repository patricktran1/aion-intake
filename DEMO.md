# Running the demo

Everything here is synthetic. There is no real patient information anywhere in
this repository or in any deployment of it.

Start at **`/demo`**. It has the reset, the intake link, the answers to read
aloud, and a direct link to whatever brief you just created. It is a third
surface on purpose — the patient and clinician screens stay exactly what a
patient and a dermatologist would see.

---

## The two-minute demo

For someone standing up, holding a coffee. No phone changes hands.

1. Open **`/clinician`** and pick **Robert Osei**. Say nothing.
2. Let them read. Most dermatologists have the case in about fifteen seconds:
   a dark spot on the upper back, present for years, reported by his wife as
   darker and larger, bled once on a towel, twenty years roofing, brother had a
   melanoma.
3. Tap **Show patient's own words**. Every line opens to reveal the sentence the
   patient actually typed. That is the trust argument and it takes one click.
4. Point at **Clarify in visit**. It says the change was reported by his wife —
   he cannot see it himself. That is the thing a dermatologist would otherwise
   have to discover in the room.

Then ask the only question that matters: *how long does taking that history
usually take you?*

## The five-minute demo

For someone who will sit down. This is the one that lands.

1. On `/demo`, press **Reset and start the intake**. It resets and takes you
   straight to the patient link.
2. Hand them the phone. Read the answers aloud while they type — they are on the
   `/demo` page under **The answers to read aloud**.
3. **Say this out loud when it happens:** the second question is about the
   jawline and scarring, not a generic "where is it". The interview chose that
   because of what he said first. And it will skip at least one question
   entirely, because he already answered it.
4. Add a photo. Correct one line on the review screen — that is the patient's
   veto, and it is the answer to "what if the AI got it wrong".
5. Submit, then open **the brief you just created** from `/demo`.
6. Enter a diagnosis and plan in **After the visit**, press **Generate draft
   note**, and show that the patient's history and their assessment are in
   separate labelled blocks.

## The conference case

`Daniel Whitaker`, acne with early scarring. Chosen because it shows all four
things at once: a pathway that is obviously specific, questions that visibly
adapt, a treatment history with two products and two different responses, and a
goal with a deadline.

The eight answers live in `src/lib/demo/seed.ts` as `CONFERENCE_CASE` and are
rendered on `/demo`. Six or seven of them get asked; the rest are harvested from
the answers already given. **When the interview skips one, name it.**

## What to say, in one sentence each

- **What it is:** "It interviews the patient before the visit and hands you the
  history."
- **Why it is not a form:** "One answer decides the next question, so it asks six
  things instead of forty."
- **Why you can trust it:** "Every line opens to the patient's own words, and it
  will not write anything they did not say."
- **What it costs:** "About a cent an intake, and it runs with no model at all if
  you want it to."

## If something goes wrong

Press **Reset only** and reload. Everything is in memory, so a restart is a clean
slate and the two open intake links never change — a printed QR code keeps
working across resets and redeploys.

If the app is unreachable, the demo is over; there is no offline mode. That is a
deliberate consequence of keeping infrastructure at zero before
product-market fit.

## What not to claim

Do not say it is HIPAA compliant. Do not say it is ready for patients. Do not
let a photo be described as analysed — nothing looks at them. If a
dermatologist asks what it would take to pilot this for real, the honest answer
is in `PILOT_READINESS.md` and it is a short list, not a shrug.
