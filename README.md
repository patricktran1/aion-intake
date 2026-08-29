# AION Intake

**Pre-visit intelligence for dermatology.**
*Walk into the room already knowing the story.*

AION Intake holds a short, adaptive conversation with a dermatology patient
before their appointment, and hands the dermatologist a brief they can read in
thirty seconds — plus an editable draft HPI, the patient's reference photos, and
a short list of what is still worth asking in the room.

It is pre-visit preparation. It is not telehealth, not a visit, and not medical
advice. See `SCOPE.md` for what it deliberately refuses to be.

**Live demo (synthetic data only): <https://aion-intake.vercel.app>**
Start at [the clinician view](https://aion-intake.vercel.app/clinician) to see
three finished briefs, or
[do an intake yourself](https://aion-intake.vercel.app/intake/demoacne0000acne0000demo0000)
and then read your own.

---

## Run it

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

No API key is required. Without one, the interview, the brief, and the draft HPI
are produced by the deterministic engine at zero cost — the whole product works.
With one, the same engine gains language understanding and better prose.

```bash
cp .env.example .env.local   # then set ANTHROPIC_API_KEY if you want model mode
```

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Unset: deterministic mode. Set: model-backed extraction and drafting. |
| `AION_MODEL` | Model id. Defaults to `claude-haiku-4-5`. |
| `CLINICIAN_ACCESS_CODE` | Unset: clinician view is open. Set: shared passphrase required. |

## Walk the demo

Everything is synthetic. There is no real patient data in this repository.

- **`/`** — both doors, and the demo controls.
- **`/clinician`** — three completed intakes waiting: a rash, a spot of concern,
  and hair loss.
- **`/intake/demoacne0000acne0000demo0000`** — an open acne intake. Do it
  yourself, on a phone if you can, then read your own brief on the clinician side.
- **`/intake/demoopen0000open0000demo0000`** — an open intake with no pathway
  assumed; type anything and watch which questions it chooses.

Reset at any time from the home page, or:

```bash
curl -X POST http://localhost:3000/api/demo/reset
```

Data lives in memory and resets when the process restarts.

## Verify it

```bash
npm run verify     # typecheck, lint, tests, production build
```

Individually: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.

Three scripts do the work that tests cannot:

```bash
npx tsx scripts/simulate.ts          # every scenario, with its resulting brief
npx tsx scripts/simulate.ts lesion   # full detail for matching scenarios
npx tsx scripts/cost.ts              # measured AI cost per completed intake
node scripts/qa.mjs --full           # browser QA across ten breakpoints
```

`scripts/qa.mjs` needs the app running (`npm run build && npm start`, or point
`BASE` at any deployment) and writes screenshots to `$SHOTS`.

## Deploy it

Optimised for Vercel, and cheap enough to leave running.

```bash
npx vercel --prod
```

Set `CLINICIAN_ACCESS_CODE` in the project's environment before sharing the URL,
so a synthetic-but-clinical-looking demo is not simply open to the internet.
Optionally set `ANTHROPIC_API_KEY` for model mode.

**Deploy the demo only.** Before this holds a single real patient answer, read
`SECURITY.md` — durable encrypted storage, real clinician authentication, real
patient linking, an audit log, and signed BAAs are all prerequisites, not
follow-ups.

## How it is built

Next.js 16 · React 19 · TypeScript · Tailwind 4 · Zod · Vitest. One process, one
in-memory store, no vendors. Nothing here needs paying for before there is
something to prove.

```
src/
  app/                     routes and API handlers
  components/
    patient/               mobile-first intake: composer, voice, photos, review
    clinician/             the brief, the HPI, the scratchpad
  lib/
    interview/
      slots.ts             what each pathway asks, and why — the product IP
      engine.ts            pathway selection, question planning, certainty
      conduct.ts           one turn: engine decides what, model decides how
    ai/
      prompts.ts           every prompt, versioned, in one file
      guard.ts             the hallucination controls
      compose.ts           deterministic brief, HPI, and note
      client.ts            the Anthropic wrapper, with token accounting
      cost.ts              pricing, checked into source
    store/                 the eight functions a real database would implement
    analytics/             ring buffer, PHI-stripping, /api/metrics
    demo/seed.ts           synthetic patients
tests/                     scenario library, fidelity, failure injection
scripts/
  simulate.ts              run every scenario, print the resulting briefs
  qa.mjs                   drive the product across ten breakpoints
  cost.ts                  measure AI cost per intake
```

## The documents

| | |
| --- | --- |
| `PRODUCT.md` | The wedge, the users, the promise, the golden path |
| `SCOPE.md` | What this deliberately refuses to build |
| `AI.md` | Where AI is used, the hallucination controls, the cost model |
| `SECURITY.md` | What is true today, and what must be true before real PHI |
| `THREAT_MODEL.md` | Who would attack this, what stops them, where nothing does |
| `EVALS.md` | The evaluation lab: how the interview is measured |
| `GOLDEN_SET.md` | The 49 hand-reviewed cases and what each one protects |
| `MODEL_EVAL.md` | Model vs deterministic, per stage — and what is still unmeasured |
| `METRICS.md` | The four numbers that decide whether the wedge is real |
| `DEMO.md` | How to run the two-minute and five-minute demos |
| `PILOT_READINESS.md` | What must be true before a single real patient |
| `PILOT_ARCHITECTURE.md` | Running it for 5-20 dermatologists, 100-2,000 intakes/month |
| `CONTRIBUTING.md` | For whoever picks this up next |
| `DEFERRED.md` | Good ideas deliberately not built, and why |

## Safety boundaries

Built in, not bolted on:

- No autonomous diagnosis — the interview will not say what it thinks a
  condition is, even when asked directly
- No image analysis; photos are reference material for the visit
- No prescribing; nothing is transmitted to any pharmacy
- No invented clinical content in the draft HPI — no examination findings, no
  negatives the patient did not state, no assessment, no sharpened hedges
- Urgent language triggers emergency guidance and a physician flag, never an
  assessment
