import type { Certainty, Fact, Intake, Pathway } from "@/lib/domain/types";
import { MAX_QUESTIONS, OPENING_SLOT, PATHWAY_SLOTS, type Slot } from "./slots";

/**
 * The deterministic backbone of the interview.
 *
 * Every decision that can be made with rules is made with rules: which pathway
 * we are on, which slot to ask next, when we have enough, whether the answer
 * was empty. The model is used only where language understanding genuinely
 * helps (see src/lib/ai). That split is what keeps the cost per intake in
 * fractions of a cent and the behaviour testable.
 */

/**
 * Complaint families are matched with weighted patterns rather than plain
 * substrings, because patients say "my hair has been falling out" far more often
 * than they say "hair loss".
 */
const PATHWAY_SIGNALS: Record<Exclude<Pathway, "general">, { re: RegExp; weight: number }[]> = {
  lesion: [
    { re: /\b(mole|moles)\b/, weight: 12 },
    { re: /\b(lesion|growth|keratosis|wart|cyst)\b/, weight: 10 },
    { re: /\b(spot|bump|mark|freckle)\b/, weight: 7 },
    { re: /\bskin cancer|melanoma|basal cell|squamous\b/, weight: 14 },
    { re: /\bsore that (won'?t|will not|doesn'?t|does not) heal\b/, weight: 14 },
    { re: /\b(changing|changed|new|dark|bleeding)\s+(spot|mole|bump|patch)\b/, weight: 12 },
    { re: /\bskin check\b/, weight: 8 },
  ],
  acne: [
    { re: /\bacne\b/, weight: 14 },
    { re: /\b(pimple|pimples|zit|zits|blackhead|whitehead|blemish|blemishes)\b/, weight: 12 },
    { re: /\bbreak(ing)? out\b/, weight: 10 },
    { re: /\bbreakouts?\b/, weight: 10 },
    { re: /\bcystic\b/, weight: 8 },
  ],
  hair_loss: [
    { re: /\bhair\b[^.?!]{0,30}\b(loss|losing|falling|fall(s|ing)? out|shedding|thin(ning)?|comes? out)\b/, weight: 16 },
    { re: /\b(losing|lost)\b[^.?!]{0,20}\bhair\b/, weight: 16 },
    { re: /\bhair loss|hair thinning|alopecia\b/, weight: 16 },
    { re: /\b(bald|balding|bald spot|hairline|receding)\b/, weight: 12 },
    { re: /\b(scalp is showing|part (is|looks) wider|widening part)\b/, weight: 12 },
    { re: /\bshedding\b/, weight: 8 },
  ],
  rash: [
    { re: /\brash(es)?\b/, weight: 14 },
    { re: /\b(eczema|dermatitis|psoriasis|hives|welts)\b/, weight: 14 },
    { re: /\b(itchy|itching|itches)\b/, weight: 7 },
    { re: /\b(red|dry|scaly|flaky|raised)\s+(patch|patches|spots|skin|bumps)\b/, weight: 10 },
    { re: /\b(flaky|scaly|peeling)\b/, weight: 5 },
  ],
};

/**
 * Pathways are intake routes, not diagnoses. Picking "lesion" says only that we
 * will ask lesion-shaped questions.
 */
export function detectPathway(text: string): Pathway {
  const hay = ` ${text.toLowerCase()} `;
  let best: Pathway = "general";
  let bestScore = 0;
  for (const [pathway, signals] of Object.entries(PATHWAY_SIGNALS) as [
    Exclude<Pathway, "general">,
    { re: RegExp; weight: number }[],
  ][]) {
    const score = signals.reduce((acc, s) => (s.re.test(hay) ? acc + s.weight : acc), 0);
    if (score > bestScore) {
      bestScore = score;
      best = pathway;
    }
  }
  return best;
}

/**
 * Language that should stop the intake and point the patient at real care.
 * Intentionally narrow and non-diagnostic: it triggers a safety message, never
 * an assessment.
 */
const URGENT_SIGNALS = [
  "trouble breathing", "can't breathe", "cant breathe", "difficulty breathing",
  "throat closing", "swelling of my face", "face is swelling", "lips are swelling",
  "anaphylaxis", "chest pain", "passing out", "fainted", "high fever",
  "skin is peeling off", "blisters in my mouth", "sepsis",
  "suicidal", "kill myself", "hurt myself",
];

export function detectUrgent(text: string): boolean {
  const hay = text.toLowerCase();
  return URGENT_SIGNALS.some((s) => hay.includes(s));
}

export function slotsForPathway(pathway: Pathway): Slot[] {
  return PATHWAY_SLOTS[pathway];
}

export function findSlot(pathway: Pathway, id: string): Slot | undefined {
  if (id === OPENING_SLOT.id) return OPENING_SLOT;
  return PATHWAY_SLOTS[pathway].find((s) => s.id === id);
}

export interface PlanResult {
  /** The next question to ask, or null when the interview has enough. */
  slot: Slot | null;
  /** Why we stopped. Surfaced in tests and analytics, never to the patient. */
  reason: "opening" | "next" | "budget_reached" | "complete";
}

const hasFact = (facts: Fact[], slotId: string) =>
  facts.some((f) => f.slot === slotId && f.value.trim().length > 0);

/**
 * Choose the next question.
 *
 * The pathway author's ordering is clinical, so it is respected literally: we
 * walk the slot list in order and take the first one still worth asking. The
 * only thing that overrides that order is the budget — when the remaining
 * questions are exactly enough for the core slots that are left, conditional
 * slots are dropped rather than crowding out something a dermatologist needs.
 * The patient's own goal is always held back for last.
 */
export function planNextQuestion(intake: Pick<Intake, "pathway" | "facts" | "askedSlots" | "questionCount">): PlanResult {
  if (intake.questionCount === 0) return { slot: OPENING_SLOT, reason: "opening" };
  if (intake.questionCount >= MAX_QUESTIONS) return { slot: null, reason: "budget_reached" };

  const asked = new Set(intake.askedSlots);
  const ctx = { pathway: intake.pathway, facts: intake.facts, text: "" };
  const pending = slotsForPathway(intake.pathway).filter(
    (s) => !asked.has(s.id) && !hasFact(intake.facts, s.id),
  );

  const goal = pending.find((s) => s.id === "goal") ?? null;
  const rest = pending.filter((s) => s.id !== "goal");
  const questionsLeft = MAX_QUESTIONS - intake.questionCount;

  // The last question always belongs to the patient, not to us.
  if (goal && questionsLeft <= 1) return { slot: goal, reason: "next" };

  for (let i = 0; i < rest.length; i += 1) {
    const slot = rest[i];
    if (slot.tier === "conditional") {
      if (slot.askWhen && !slot.askWhen(ctx)) continue;
      // Would asking this leave room for every core slot still ahead, plus goal?
      const coreAhead = rest.slice(i + 1).filter((s) => s.tier === "core").length;
      const needed = coreAhead + (goal ? 1 : 0);
      if (questionsLeft - 1 < needed) continue;
    }
    return { slot, reason: "next" };
  }

  if (goal) return { slot: goal, reason: "next" };
  return { slot: null, reason: "complete" };
}

/** True when every core slot for the pathway carries a value. */
export function coreComplete(intake: Pick<Intake, "pathway" | "facts">): boolean {
  return slotsForPathway(intake.pathway)
    .filter((s) => s.tier === "core")
    .every((s) => hasFact(intake.facts, s.id));
}

const NON_ANSWERS = [
  "idk", "i don't know", "i dont know", "not sure", "no idea", "dunno",
  "can't remember", "cant remember", "don't remember", "dont remember", "unsure",
];

const HEDGES = ["i think", "maybe", "around", "about", "roughly", "probably", "sometime", "or so", "-ish", "guess"];

/**
 * Certainty is decided from the patient's own words, never from how confident
 * the summary would like to sound.
 */
export function classifyCertainty(text: string): Certainty {
  const t = text.toLowerCase().trim();
  if (t.length === 0) return "unclear";
  if (NON_ANSWERS.some((n) => t.includes(n))) return "unclear";
  if (HEDGES.some((h) => t.includes(h))) return "approximate";
  return "stated";
}

export function isEmptyAnswer(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Deterministic extraction: used verbatim when no model is configured, and as
 * the fallback whenever a model response fails validation.
 *
 * It never invents content. The value it stores is a tidied version of what the
 * patient typed, attributed to the slot the question targeted.
 */
export function extractDeterministic(slot: Slot, answer: string, at: string): Fact[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  const certainty = classifyCertainty(trimmed);
  return [
    {
      slot: slot.id,
      value: tidy(trimmed),
      verbatim: trimmed,
      certainty,
      source: "patient",
      at,
    },
  ];
}

/** Sentence-cases and trims without changing a single word of meaning. */
export function tidy(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Questions the physician should raise in the room: slots we asked about but
 * could not resolve, plus anything the patient told us they want to ask.
 */
export function computeOpenQuestions(intake: Pick<Intake, "pathway" | "facts" | "askedSlots">): string[] {
  const out: string[] = [];
  for (const slotId of intake.askedSlots) {
    const slot = findSlot(intake.pathway, slotId);
    if (!slot) continue;
    const facts = intake.facts.filter((f) => f.slot === slotId);
    if (facts.length === 0) {
      out.push(`${slot.briefLabel} — patient skipped this question.`);
      continue;
    }
    if (facts.some((f) => f.certainty === "unclear")) {
      out.push(`${slot.briefLabel} — patient was unsure ("${truncate(facts[0].verbatim, 80)}").`);
    } else if (facts.some((f) => f.certainty === "approximate")) {
      out.push(`${slot.briefLabel} — approximate only ("${truncate(facts[0].verbatim, 80)}").`);
    }
  }
  const unasked = slotsForPathway(intake.pathway)
    .filter((s) => s.tier === "core" && !intake.askedSlots.includes(s.id));
  for (const slot of unasked) {
    out.push(`${slot.briefLabel} — not covered before the question budget ran out.`);
  }
  return out;
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
