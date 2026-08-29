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
    { re: /\b(?:thing|lump|patch|blemish|scab|sore)\b[^.?!]{0,20}\bon my\b/, weight: 8 },
  ],
  acne: [
    { re: /\bacne\b/, weight: 14 },
    { re: /\b(pimple|pimples|zit|zits|blackhead|whitehead|blemish|blemishes)\b/, weight: 12 },
    { re: /\bbreak(ing)? out\b/, weight: 10 },
    { re: /\bbreakouts?\b/, weight: 10 },
    { re: /\bcystic\b/, weight: 8 },
  ],
  hair_loss: [
    { re: /\bhair\b[^.?!]{0,30}\b(loss|losing|fall(?:s|ing)?|shed(?:s|ding)?|thin(?:ning)?|com(?:es|ing) out|coming out|breaking off)\b/, weight: 16 },
    { re: /\b(losing|lost)\b[^.?!]{0,20}\bhair\b/, weight: 16 },
    { re: /\bhair loss|hair thinning|alopecia\b/, weight: 16 },
    { re: /\b(bald|balding|bald spot|hairline|receding)\b/, weight: 12 },
    { re: /\b(scalp is showing|part (is|looks) wider|widening part)\b/, weight: 12 },
    { re: /\bshedding\b/, weight: 8 },
    { re: /\b(?:worried|concerned) about my hair\b|\bmy hair\b/, weight: 9 },
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

/** A slot answered only in part still has a question worth asking. */
export const isPartiallyFilled = (facts: Fact[], slotId: string): boolean => {
  const own = facts.filter((f) => f.slot === slotId && f.value.trim().length > 0);
  return own.length > 0 && own.every((f) => f.partial === true);
};

const isSettled = (facts: Fact[], slotId: string) =>
  hasFact(facts, slotId) && !isPartiallyFilled(facts, slotId);

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
    (s) => !asked.has(s.id) && !isSettled(intake.facts, s.id),
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

/**
 * How many questions are probably left.
 *
 * Honest rather than fixed: harvesting means a patient who explains everything
 * up front really does get fewer questions, and telling them "3 of about 9"
 * when they will be asked six more is both wrong and discouraging.
 */
export function estimateRemaining(
  intake: Pick<Intake, "pathway" | "facts" | "askedSlots" | "questionCount">,
): number {
  const asked = new Set(intake.askedSlots);
  const pending = slotsForPathway(intake.pathway).filter(
    (s) => !asked.has(s.id) && !isSettled(intake.facts, s.id),
  );
  const core = pending.filter((s) => s.tier === "core").length;
  const budgetLeft = Math.max(0, MAX_QUESTIONS - intake.questionCount);
  // Conditional slots only get asked if there is room after the core ones.
  const optional = Math.min(pending.length - core, Math.max(0, budgetLeft - core));
  return Math.min(budgetLeft, core + optional);
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
  "no comment", "pass", "skip", "n/a", "?", "??",
];

/**
 * A bare "no" is an answer, and a clinically useful one — "No, it doesn't
 * bleed" is a patient-stated negative the physician can rely on. Only the
 * *absence* of knowledge counts as a non-answer.
 */
const STATED_ANSWER = /^(no|nope|none|nothing|never|nah|yes|yeah|yep|yup|correct|right)\b/i;

/** "No idea" opens with "no" but is the opposite of a stated negative. */
const NON_ANSWER_PREFIX = /^(no idea|no clue|not sure|don'?t know|dont know|can'?t say|couldn'?t say)\b/i;

/**
 * True when an answer carries no information at all — "not sure", "dunno", "".
 *
 * This matters more than it looks. A non-answer stored as a fact becomes a
 * brief row reading "Symptoms: Not sure" and an HPI line reading "Symptoms: Not
 * sure (patient unsure)". Both are noise dressed as content. A non-answer
 * belongs in "clarify in visit" and nowhere else.
 */
export function isNonAnswer(text: string): boolean {
  const t = text.toLowerCase().trim().replace(/[.!]+$/, "");
  if (t.length === 0) return true;
  if (NON_ANSWER_PREFIX.test(t)) return true;
  if (STATED_ANSWER.test(t)) return false;
  if (NON_ANSWERS.includes(t)) return true;

  // Beyond the exact phrases, only text that *contains* a non-answer gets
  // scrutinised. "Breakouts" is one word and a perfectly good answer; "I'm not
  // sure really" is four and is not.
  const carriesNonAnswer = NON_ANSWERS.some((n) => n.length > 3 && t.includes(n));
  if (!carriesNonAnswer) return false;

  let rest = t;
  for (const n of NON_ANSWERS) rest = rest.split(n).join(" ");
  rest = rest.replace(/\b(i|really|honestly|sorry|um|uh|well|maybe|it|is|the|a|an|to|of|about|so|just|but|and|or|that|this|my|too|either)\b/g, " ");
  return rest.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).length < 2;
}

const HEDGES = ["i think", "maybe", "around", "about", "roughly", "probably", "sometime", "or so", "-ish", "guess"];

/**
 * Certainty is decided from the patient's own words, never from how confident
 * the summary would like to sound.
 */
export function classifyCertainty(text: string): Certainty {
  const t = text.toLowerCase().trim();
  // Reuse the non-answer test rather than substring-matching short tokens.
  // Matching "?" anywhere marked "Can it come back?" as unclear, which turned a
  // patient's clearest statement — their own question — into noise.
  if (isNonAnswer(text)) return "unclear";
  if (HEDGES.some((h) => new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t))) {
    return "approximate";
  }
  return "stated";
}

export function isEmptyAnswer(text: string): boolean {
  return text.trim().length === 0;
}

/** Filler patients open with. Stripping it makes the headline readable. */
const OPENING_FILLER =
  /^(?:ok(?:ay)?|so|well|hi|hello|um+|uh+|erm|basically|right|yeah|yes|hey)\b[,\s]*/i;

export function stripFiller(text: string): string {
  let t = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = t.replace(OPENING_FILLER, "").trimStart();
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Deterministic extraction: used verbatim when no model is configured, and as
 * the fallback whenever a model response fails validation.
 *
 * It never invents content. The value it stores is a tidied version of what the
 * patient typed, attributed to the slot the question targeted.
 */
/** Rendered in briefs and notes, so it has to stay readable. */
export const MAX_FACT_VALUE = 400;
/** Kept for provenance; long enough for a real answer, short enough to store. */
export const MAX_VERBATIM = 2000;

export function extractDeterministic(slot: Slot, answer: string, at: string): Fact[] {
  const trimmed = answer.trim();
  // An answer that says nothing is recorded as "asked, unresolved" rather than
  // as a fact whose content is the word "unsure".
  if (!trimmed || isNonAnswer(trimmed)) return [];
  const certainty = classifyCertainty(trimmed);
  return [
    {
      slot: slot.id,
      // Bounded for the same reason the model path is: a 3,000-character
      // answer must not become a 3,000-character row in a physician's brief.
      value: truncate(tidy(trimmed), MAX_FACT_VALUE),
      verbatim: trimmed.slice(0, MAX_VERBATIM),
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
 * Slots a dermatologist would actually chase in the room if the intake missed
 * them. Everything else, missing, is not worth a line of their attention.
 */
const HIGH_VALUE: Record<Pathway, string[]> = {
  rash: ["timeline", "symptoms", "treatments", "location"],
  lesion: ["lesion_timeline", "lesion_symptoms", "location", "sun_history"],
  acne: ["acne_treatments", "timeline", "acne_distribution"],
  hair_loss: ["hair_pattern", "timeline", "hair_stressors", "hair_scalp"],
  general: ["timeline", "symptoms", "location", "treatments"],
};

/** A treatment the patient could not name is a question worth 20 seconds. */
const VAGUE_TREATMENT =
  /\b(some ?cream|a cream|stuff from|something (?:my|the) (?:doctor|gp|dermatologist)|don'?t remember (?:which|the name|what)|can'?t remember (?:which|the name|what)|an old tube|some kind of|a prescription (?:from|my)|drugstore stuff|over the counter stuff)\b/i;

const RESPONSE_LANGUAGE =
  /\b(help(?:ed|s|ing)?|work(?:ed|s|ing)?|better|worse|no (?:change|difference|effect)|didn'?t|did not|nothing|improved?|cleared|made it|stopped|irritat)/i;

const TREATMENT_SLOTS = ["treatments", "acne_treatments"];

export interface ClarifyItem {
  text: string;
  /** Higher sorts first. Internal only. */
  score: number;
}

const MAX_CLARIFY = 4;

/**
 * "Clarify in visit" is the section a dermatologist reads last and trusts most,
 * so it has to be short and every line has to be worth asking.
 *
 * It is not a list of empty fields. It surfaces four kinds of thing: a question
 * the patient asked, a high-value answer that is missing or unresolved, a
 * timeline the patient could only approximate, and a treatment they named but
 * could not pin down. Everything else is dropped.
 */
export function computeOpenQuestions(
  intake: Pick<Intake, "pathway" | "facts" | "askedSlots"> & { concernCount?: number },
): string[] {
  const items: ClarifyItem[] = [];
  const highValue = HIGH_VALUE[intake.pathway];
  const factsFor = (slot: string) => intake.facts.filter((f) => f.slot === slot);

  if ((intake.concernCount ?? 1) > 1) {
    items.push({
      score: 100,
      text: `Patient raised ${intake.concernCount} separate concerns in one visit — confirm which to prioritise.`,
    });
  }

  for (const slotId of intake.askedSlots) {
    const slot = findSlot(intake.pathway, slotId);
    if (!slot) continue;
    const facts = factsFor(slotId);
    const isHigh = highValue.includes(slotId);

    if (facts.length === 0) {
      // Asked and not answered. Only worth a line if it mattered.
      if (isHigh) {
        items.push({ score: 80, text: `${slot.briefLabel} — asked, but the patient did not answer.` });
      }
      continue;
    }

    const isTimeline = slotId === "timeline" || slotId === "lesion_timeline";
    if (isTimeline && facts.some((f) => f.certainty === "approximate")) {
      const hedged = facts.find((f) => f.certainty === "approximate")!;
      items.push({
        score: 70,
        text: `Timing is the patient's estimate only — "${timingFragment(hedged.verbatim)}".`,
      });
    }

    if (TREATMENT_SLOTS.includes(slotId)) {
      const text = facts.map((f) => f.verbatim).join(" ");
      if (VAGUE_TREATMENT.test(text)) {
        items.push({ score: 65, text: `Patient could not name what they used — "${truncate(text, 70)}".` });
      } else if (!RESPONSE_LANGUAGE.test(text)) {
        items.push({ score: 60, text: `${slot.briefLabel} — what they tried is recorded, the response is not.` });
      }
    }
  }

  // Core slots the budget never reached, high value only.
  for (const slot of slotsForPathway(intake.pathway)) {
    if (slot.tier !== "core") continue;
    if (intake.askedSlots.includes(slot.id)) continue;
    if (factsFor(slot.id).length > 0) continue;
    if (!highValue.includes(slot.id)) continue;
    items.push({ score: 50, text: `${slot.briefLabel} — not covered before the interview ended.` });
  }

  // A patient who answered almost nothing needs one honest line, not eight.
  const answered = intake.askedSlots.filter((s) => factsFor(s).length > 0).length;
  if (intake.askedSlots.length >= 3 && answered <= 1) {
    return ["Patient started the intake but answered very little — the history will need to be taken in the room."];
  }

  const seen = new Set<string>();
  return items
    .sort((a, b) => b.score - a.score)
    .filter((i) => (seen.has(i.text) ? false : (seen.add(i.text), true)))
    .slice(0, MAX_CLARIFY)
    .map((i) => i.text);
}

/**
 * The part of an answer that carries the timing, so a clarify line quotes
 * "maybe 4 months" rather than three hundred characters of opening statement.
 */
const HEDGED_TIMING =
  /\b(?:i think|maybe|about|around|roughly|probably|possibly)\b[^.,;!?/]{0,25}|\bsince\s+[a-z]+\b/i;

export function timingFragment(verbatim: string): string {
  const m = verbatim.match(HEDGED_TIMING);
  return truncate((m ? m[0] : verbatim).trim(), 70);
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
