import type { Fact, Pathway } from "@/lib/domain/types";

/**
 * A slot is one thing a dermatologist would otherwise have to ask in the room.
 *
 * Slots are grouped so one conversational turn can fill two related facets
 * ("Where did you first notice it, and has it spread?"). That grouping is the
 * whole reason a useful intake fits in 3-5 minutes instead of 30 questions.
 */
export interface Slot {
  id: string;
  /** Facets this one question is expected to fill. Used by the extractor. */
  facets: string[];
  /** Deterministic phrasing. The model may re-voice it; it may not change intent. */
  question: string;
  /** Shown under the question as a gentle hint. Optional. */
  hint?: string;
  /** Label used in the physician brief. */
  briefLabel: string;
  /**
   * `core` slots are always asked. `conditional` slots are asked only when
   * `askWhen` says the answers so far make them worth a patient's time.
   */
  tier: "core" | "conditional";
  askWhen?: (ctx: SlotContext) => boolean;
  /** Quick-tap suggestions for mobile. Never the only way to answer. */
  chips?: string[];
  /**
   * Asked instead of `question` when the patient has already volunteered part
   * of the answer. Asking "when did it start?" of someone who just said "for
   * two weeks" is the fastest way to make an interview feel unheard.
   */
  narrowQuestion?: string;
}

export interface SlotContext {
  pathway: Pathway;
  facts: Fact[];
  text: string;
}

export const factText = (facts: Fact[], slot: string): string =>
  facts
    .filter((f) => f.slot === slot)
    .map((f) => `${f.value} ${f.verbatim}`)
    .join(" ")
    .toLowerCase();

const allText = (facts: Fact[]) =>
  facts.map((f) => `${f.value} ${f.verbatim}`).join(" ").toLowerCase();

const mentions = (facts: Fact[], words: string[]) => {
  const hay = allText(facts);
  return words.some((w) => hay.includes(w));
};

/** The opener. Identical for every pathway, because we do not know it yet. */
export const OPENING_SLOT: Slot = {
  id: "concern",
  facets: ["concern", "duration"],
  question:
    "What would you most like the dermatologist to help you with at your upcoming visit?",
  hint: "Describe it however feels natural — a sentence or two is plenty.",
  briefLabel: "Primary concern",
  tier: "core",
};

const SHARED_LOCATION: Slot = {
  id: "location",
  facets: ["location", "spread"],
  question: "Where on your body is it, and has it spread anywhere since it started?",
  briefLabel: "Location",
  tier: "core",
};

const SHARED_TIMELINE: Slot = {
  id: "timeline",
  facets: ["onset", "progression"],
  question:
    "When did you first notice it, and has it been getting better, worse, or staying about the same?",
  narrowQuestion: "Since it started, has it been getting better, worse, or staying about the same?",
  briefLabel: "Timeline",
  tier: "core",
  chips: ["Getting worse", "About the same", "Slowly improving", "Comes and goes"],
};

const SHARED_TREATMENTS: Slot = {
  id: "treatments",
  facets: ["treatments_tried", "treatment_response"],
  question: "Have you tried anything for it so far, and did any of it help?",
  narrowQuestion: "You mentioned trying something for it — did it help at all?",
  hint: "Creams, pills, home remedies — anything counts, including nothing yet.",
  briefLabel: "Tried so far",
  tier: "core",
  chips: ["Nothing yet", "Over-the-counter cream", "Prescription from another doctor"],
};

const SHARED_CONTEXT: Slot = {
  id: "context",
  facets: ["medications", "allergies", "medical_history"],
  question:
    "Anything the dermatologist should know about you — medications you take, allergies, or other medical conditions?",
  hint: "Only what comes to mind. You can also say \"nothing\".",
  briefLabel: "Relevant context",
  tier: "core",
};

const SHARED_GOAL: Slot = {
  id: "goal",
  facets: ["patient_goal", "patient_questions"],
  question: "Last one — what would make this visit feel worth it for you?",
  hint: "A specific worry, a question you want answered, or just \"make it stop itching\".",
  briefLabel: "Patient goal",
  tier: "core",
};

const RASH_PATH: Slot[] = [
  SHARED_LOCATION,
  SHARED_TIMELINE,
  {
    id: "symptoms",
    facets: ["itch", "pain", "other_symptoms"],
    question: "Is it mostly itchy, painful, burning, or something else?",
    briefLabel: "Symptoms",
    tier: "core",
    chips: ["Very itchy", "Mildly itchy", "Painful", "Burning or stinging", "No real symptoms"],
  },
  {
    id: "triggers",
    facets: ["triggers", "modifying_factors"],
    question: "Have you noticed anything that sets it off or makes it calm down?",
    briefLabel: "Triggers",
    tier: "core",
  },
  {
    id: "exposures",
    facets: ["exposures"],
    question:
      "Anything new around the time it started — soaps, detergents, skincare, jewellery, plants, or a change at work?",
    briefLabel: "New exposures",
    tier: "conditional",
    askWhen: ({ facts }) => !mentions(facts, ["detergent", "soap", "new lotion", "new cream", "poison ivy"]),
  },
  SHARED_TREATMENTS,
  {
    id: "atopy",
    facets: ["atopic_history", "family_history"],
    question:
      "Have you or anyone in your family had eczema, asthma, or hay fever?",
    briefLabel: "Atopic history",
    tier: "conditional",
  },
  SHARED_CONTEXT,
  SHARED_GOAL,
];

const LESION_PATH: Slot[] = [
  SHARED_LOCATION,
  {
    id: "lesion_timeline",
    facets: ["onset", "progression"],
    question:
      "How long have you had it, and has it changed at all — size, colour, shape, or border?",
    narrowQuestion: "Has it changed at all since you first noticed it — size, colour, shape, or border?",
    briefLabel: "Timeline and change",
    tier: "core",
    chips: ["It's new", "Had it for years", "It's getting bigger", "The colour changed"],
  },
  {
    id: "lesion_symptoms",
    facets: ["bleeding", "itch", "pain"],
    question: "Has it ever bled, scabbed over, itched, or been tender?",
    briefLabel: "Symptoms",
    tier: "core",
    chips: ["It bleeds sometimes", "It scabs and comes back", "It itches", "No symptoms at all"],
  },
  {
    id: "sun_history",
    facets: ["sun_exposure", "skin_cancer_history"],
    question:
      "Have you had a lot of sun or tanning bed exposure, or any skin cancers before — in you or your family?",
    briefLabel: "Sun and skin-cancer history",
    tier: "core",
  },
  {
    id: "lesion_others",
    facets: ["other_lesions"],
    question: "Are there other spots you'd like looked at while you're there?",
    briefLabel: "Other spots",
    tier: "conditional",
  },
  SHARED_TREATMENTS,
  SHARED_CONTEXT,
  SHARED_GOAL,
];

const ACNE_PATH: Slot[] = [
  {
    id: "acne_distribution",
    facets: ["location", "severity", "scarring"],
    question:
      "Where is the acne mostly — face, chest, back — and is it leaving marks or scars?",
    briefLabel: "Distribution",
    tier: "core",
  },
  SHARED_TIMELINE,
  {
    id: "acne_treatments",
    facets: ["treatments_tried", "treatment_response"],
    question:
      "What have you tried so far — washes, creams, antibiotics, anything prescription — and how did it go?",
    narrowQuestion: "You mentioned trying something — how did it go?",
    hint: "If you remember names that's great, but a rough description is fine.",
    briefLabel: "Tried so far",
    tier: "core",
    chips: ["Only drugstore products", "A prescription cream", "Antibiotic pills", "Nothing yet"],
  },
  {
    id: "acne_pattern",
    facets: ["flare_pattern", "hormonal_pattern"],
    question:
      "Does it flare in any pattern you've noticed — stress, certain times of the month, products, or shaving?",
    briefLabel: "Flare pattern",
    tier: "conditional",
  },
  {
    id: "acne_impact",
    facets: ["impact"],
    question: "How much is it affecting you day to day?",
    briefLabel: "Impact",
    tier: "conditional",
    chips: ["It really bothers me", "Somewhat", "Mostly the scarring bothers me"],
  },
  SHARED_CONTEXT,
  SHARED_GOAL,
];

const HAIR_PATH: Slot[] = [
  {
    id: "hair_pattern",
    facets: ["pattern", "location"],
    question:
      "Is the hair loss more of an overall thinning, a receding or widening part, or distinct patches?",
    briefLabel: "Pattern",
    tier: "core",
    chips: ["Overall thinning", "Widening part", "Receding hairline", "Round patches", "Lots of shedding"],
  },
  SHARED_TIMELINE,
  {
    id: "hair_scalp",
    facets: ["scalp_symptoms", "breakage"],
    question: "Is the scalp itself itchy, sore, flaky, or does it look normal?",
    briefLabel: "Scalp symptoms",
    tier: "core",
    chips: ["Scalp feels normal", "Itchy", "Sore or tender", "Flaky"],
  },
  {
    id: "hair_stressors",
    facets: ["stressors", "medications"],
    question:
      "In the few months before it started, was there anything big — an illness, major stress, a weight change, pregnancy, or a new medication?",
    briefLabel: "Preceding events",
    tier: "core",
  },
  {
    id: "hair_care",
    facets: ["hair_care"],
    question:
      "How do you usually wear and treat your hair — tight styles, heat, relaxers, colour, extensions?",
    briefLabel: "Hair care",
    tier: "conditional",
  },
  SHARED_TREATMENTS,
  SHARED_CONTEXT,
  SHARED_GOAL,
];

const GENERAL_PATH: Slot[] = [
  SHARED_LOCATION,
  SHARED_TIMELINE,
  {
    id: "symptoms",
    facets: ["itch", "pain", "other_symptoms"],
    question: "What does it actually feel like — itchy, sore, burning, or nothing much?",
    briefLabel: "Symptoms",
    tier: "core",
    chips: ["Itchy", "Sore", "Burning", "No symptoms"],
  },
  SHARED_TREATMENTS,
  {
    id: "triggers",
    facets: ["triggers", "modifying_factors"],
    question: "Anything that seems to make it better or worse?",
    briefLabel: "Triggers",
    tier: "conditional",
  },
  SHARED_CONTEXT,
  SHARED_GOAL,
];

export const PATHWAY_SLOTS: Record<Pathway, Slot[]> = {
  rash: RASH_PATH,
  lesion: LESION_PATH,
  acne: ACNE_PATH,
  hair_loss: HAIR_PATH,
  general: GENERAL_PATH,
};

/** Hard ceiling on assistant questions, opener included. Patients have lives. */
export const MAX_QUESTIONS = 9;
