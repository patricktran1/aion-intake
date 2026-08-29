import type { Fact } from "@/lib/domain/types";

/**
 * Harvesting: reading what the patient already told us, so we do not ask again.
 *
 * Patients rarely answer the opening question with one fact. They say
 * "itchy scaly rash on both elbows for four months, hydrocortisone did nothing,
 * my dad has psoriasis" — which is six answers. An interview that then asks
 * "where is it?" has spent a question, annoyed the patient, and learned nothing.
 *
 * This module finds the clauses in a free-text answer that already cover other
 * slots. It is deliberately conservative and deliberately deterministic:
 *  - it never invents a value; the stored value is the patient's own clause
 *  - it only claims a slot on a strong, specific signal
 *  - a false negative costs one question, which is cheap; a false positive
 *    silently drops a question a dermatologist needed, which is not
 */

export interface HarvestSignal {
  /** Slot ids this signal can satisfy, in preference order. */
  slots: string[];
  test: RegExp;
  label: string;
  /** If the clause matches this, the signal does NOT fire. */
  reject?: RegExp;
  /**
   * How to reduce the matched clause to this signal's own words. "span" keeps
   * the match and a word of lead-in; "list" collects every match in the clause.
   * Omitted means the whole clause is the answer.
   */
  focus?: "list" | "span";
}

/** Body sites patients actually name. Used for location harvesting. */
const BODY_SITES = [
  "face", "cheek", "cheeks", "forehead", "nose", "chin", "jaw", "jawline", "temple", "temples",
  "scalp", "hairline", "crown", "neck", "chest", "back", "shoulder", "shoulders", "arm", "arms",
  "forearm", "forearms", "elbow", "elbows", "wrist", "hand", "hands", "finger", "fingers",
  "fingernail", "fingernails", "stomach", "abdomen", "groin", "buttock", "thigh", "thighs",
  "knee", "knees", "shin", "shins", "leg", "legs", "calf", "ankle", "foot", "feet", "toe", "toes",
  "toenail", "toenails", "nail", "nails", "eyelid", "ear", "ears", "lip", "lips", "underarm",
  "underarms", "armpit", "armpits", "palm", "palms", "sole", "soles", "trunk", "torso", "buttocks",
];

const DURATION =
  /\b(?:for\s+)?(?:about|around|maybe|roughly|approximately|nearly|over|almost)?\s*(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|couple|several)\s*(?:-|\s)?(?:day|week|month|year)s?\b/i;

const SINCE =
  /\b(?:since|starting|started|began|first noticed|noticed it)\b[^.!?]{0,60}\b(?:childhood|birth|teenager|teens|puberty|last|this|spring|summer|autumn|fall|winter|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}|i was \d+)\b/i;

const TREATMENT_TERMS =
  /\b(hydrocortisone|clobetasol|triamcinolone|betamethasone|mometasone|steroid|cortisone|tacrolimus|pimecrolimus|eucerin|cerave|cetaphil|aquaphor|vaseline|moisturi[sz]er|emollient|benzoyl peroxide|salicylic|adapalene|tretinoin|retinoid|differin|clindamycin|doxycycline|minocycline|erythromycin|isotretinoin|accutane|spironolactone|antibiotic|antifungal|antihistamine|benadryl|minoxidil|rogaine|finasteride|biotin|ketoconazole|nizoral|head and shoulders|selsun|lamisil|terbinafine|metronidazole|azelaic|niacinamide|nail lacquer|cream|ointment|lotion|gel|wash|shampoo)\b/i;

const TRIED =
  /\b(i(?:'ve)?\s+(?:tried|used|been using|been on|take|took|am using|applied)|prescribed|gave me|put me on|currently (?:using|on))\b/i;

/**
 * An explicit "nothing tried" is worth harvesting; a bare "the stuff I've
 * tried" is not — it names no treatment, so harvesting it as a settled fact
 * silently suppresses the treatment question and the physician never learns
 * the patient could not name what they used.
 */
const NO_TREATMENT =
  /\b(haven'?t tried anything|hasn'?t tried anything|not tried anything|haven'?t tried anything yet|no treatment|never tried anything|tried nothing|nothing (?:for it|has helped|helped|worked)|haven'?t used anything)\b/i;

const SYMPTOM_TERMS =
  /\b(itch(?:y|es|ing)?|pain(?:ful)?|sore|burn(?:s|ing)?|sting(?:s|ing)?|tender|bleed(?:s|ing)?|scab(?:s|bing|bed)?|crust(?:s|ing|y)?|flak(?:y|ing|es)|scal(?:y|ing|es)|dry|crack(?:s|ing|ed)|ooz(?:e|ing)|weep(?:s|ing)|swollen|swelling|blister(?:s|ing)?|numb|tingl(?:e|ing))\b/i;

const MEDICATION_STATEMENT =
  /\b(i (?:take|am on|'m on)|on (?:daily )?(?:medication|meds)|metformin|lisinopril|levothyroxine|atorvastatin|amlodipine|sertraline|omeprazole|prednisone|insulin|birth control|the pill|aspirin|ibuprofen|warfarin|methotrexate|biologic|prenatal)\b/i;

const ALLERGY_STATEMENT = /\b(allergic to|allergy to|allergies?\b[^.!?]{0,20}\b(?:to|include))\b/i;

const FAMILY_STATEMENT =
  /\b(my (?:mum|mom|mother|dad|father|brother|sister|son|daughter|aunt|uncle|grandmother|grandfather|parents?|family)\b|runs in (?:my|the) family|family history)\b/i;

const ATOPY_TERMS = /\b(eczema|asthma|hay ?fever|atopic|allergies)\b/i;
/**
 * A first-person present-tense belief about a diagnosis ("I know this is
 * melanoma") is the patient's opinion, not a history. It must not be filed
 * under "sun and skin-cancer history", where it would read as established.
 */
const SELF_DIAGNOSIS =
  /\bi\s+(?:know|think|believe|reckon|am sure|'m sure|was told|read|googled)\b|\b(?:looks like|it'?s definitely|pretty sure)\b/i;

const SUN_TERMS =
  /\b(sun ?burn(?:s|ed|t)?|tanning|sun ?bed|outdoors?|roof(?:ing|er)|sail|beach|melanoma|skin cancer|basal cell|squamous)\b/i;
const HAIRCARE_TERMS =
  /\b(braid(?:s|ed|ing)?|weave|extensions?|relax(?:er|ed|ing)|perm|straighten(?:er|ing)?|blow ?dr(?:y|ier)|flat ?iron|dye|colou?r(?:ed|ing)? my hair|ponytail|bun|tight)\b/i;
const TRIGGER_TERMS =
  /\b(worse (?:when|with|after|in|before)|better (?:when|with|after|in)|flares? (?:with|when|after|up)|sets? it off|triggered by|brings? it on|makes? it (?:worse|better))\b/i;
const EXPOSURE_TERMS =
  /\b(new (?:detergent|soap|lotion|cream|product|skincare|jewell?ery|perfume|shampoo)|changed (?:detergent|soap|products?)|started (?:a )?(?:new )?job|poison ivy|hot tub|swimming pool|chemicals?|gloves)\b/i;

/**
 * Signals are ordered most specific first. Each names the slots it can satisfy
 * across the different pathways; the caller keeps only the ones that belong to
 * the pathway actually in play.
 */
const SIGNALS: HarvestSignal[] = [
  // A named treatment, or an explicit "nothing tried", is harvestable. A bare
  // "tried"/"used" with neither is intentionally NOT harvested, so the engine
  // asks the treatment question rather than filing a contentless fact.
  { slots: ["treatments", "acne_treatments"], test: TREATMENT_TERMS, label: "treatment" },
  { slots: ["treatments", "acne_treatments"], test: NO_TREATMENT, label: "no-treatment" },
  { slots: ["context"], test: ALLERGY_STATEMENT, label: "allergy" },
  { slots: ["context"], test: MEDICATION_STATEMENT, label: "medication" },
  { slots: ["atopy"], test: new RegExp(`${FAMILY_STATEMENT.source}[^.!?]{0,80}${ATOPY_TERMS.source}|${ATOPY_TERMS.source}[^.!?]{0,80}${FAMILY_STATEMENT.source}`, "i"), label: "atopy" },
  { slots: ["sun_history"], test: SUN_TERMS, label: "sun", reject: SELF_DIAGNOSIS },
  { slots: ["hair_care"], test: HAIRCARE_TERMS, label: "hair care" },
  { slots: ["exposures"], test: EXPOSURE_TERMS, label: "exposure" },
  { slots: ["triggers", "acne_pattern"], test: TRIGGER_TERMS, label: "trigger" },
  { slots: ["timeline", "lesion_timeline"], test: SINCE, label: "onset", focus: "span" },
  { slots: ["timeline", "lesion_timeline"], test: DURATION, label: "duration", focus: "span" },
  { slots: ["symptoms", "lesion_symptoms", "hair_scalp"], test: SYMPTOM_TERMS, label: "symptom", focus: "list" },
];

const LOCATION_RE = new RegExp(`\\b(?:${BODY_SITES.join("|")})\\b`, "i");

/** Split into sentence-ish clauses so a harvested value quotes a real span. */
export function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s*[;•]\s*|,\s+(?=(?:and\s+)?(?:i|it|my|then|but|the)\b)/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function firstMatchingClause(text: string, re: RegExp): string | null {
  for (const c of clauses(text)) {
    if (re.test(c)) return c;
  }
  return re.test(text) ? text.trim() : null;
}

/**
 * Reduce a clause to the part that actually answers the slot.
 *
 * One clause can satisfy three signals at once — "itchy red scaly rash on both
 * elbows and knees for maybe 4 months" answers symptoms, location and timing.
 * Storing the whole clause three times under three headings is worse than
 * useless, so each signal takes only its own words.
 */
function focus(clause: string, re: RegExp, kind: "list" | "span"): string {
  if (kind === "span") {
    // The signal regexes already capture their own lead-in ("for about three
    // weeks", "since May"), so the match alone is the answer. Widening it by a
    // word turns "for maybe 4 months" into "knees for maybe 4 months".
    const m = clause.match(re);
    return m ? m[0].trim() : clause;
  }
  const global = new RegExp(re.source, "gi");
  const found = [...clause.matchAll(global)].map((m) => m[0].toLowerCase());
  const unique = [...new Set(found)];
  if (unique.length === 0) return clause;
  // Preserve a leading quantifier ("both elbows", "all over my legs").
  const first = unique[0];
  const idx = clause.toLowerCase().indexOf(first);
  const qualifier = clause.slice(Math.max(0, idx - 12), idx).match(/\b(both|all|left|right|upper|lower|my|the)\s*$/i)?.[0] ?? "";
  return `${qualifier}${unique.join(", ")}`.replace(/\s+/g, " ").trim();
}

const MAX_HARVEST_LEN = 220;

/**
 * @param text          The patient's free-text answer, usually the opener.
 * @param eligibleSlots Slot ids the current pathway could still ask about.
 * @returns One fact per satisfied slot, quoting the clause it came from.
 */
export function harvest(text: string, eligibleSlots: string[], at: string): Fact[] {
  const trimmed = text.trim();
  // Below this, the answer is a phrase and not a story; harvesting it would
  // claim slots on almost no evidence.
  if (trimmed.length < 25) return [];

  const eligible = new Set(eligibleSlots);
  const out: Fact[] = [];
  const claimed = new Set<string>();

  /**
   * Slots whose question asks two things. A harvested clause usually answers
   * only the first, so the fact is marked partial and the interview asks a
   * narrowed version rather than either re-asking or silently going without.
   */
  const PARTIAL_SLOTS: Record<string, RegExp> = {
    timeline: /\b(worse|better|improv|spread|same|changing|changed|growing|slow|fast|progress)/i,
    lesion_timeline: /\b(chang|grew|grow|bigger|darker|colou?r|shape|border|same|new)/i,
    treatments: /\b(help(?:ed|s)?|work(?:ed|s)?|no (?:change|difference|effect)|better|worse|didn'?t|nothing|stopped|irritat)/i,
    acne_treatments: /\b(help(?:ed|s)?|work(?:ed|s)?|no (?:change|difference|effect)|better|worse|didn'?t|nothing|stopped|irritat)/i,
  };

  const claim = (slot: string, clause: string, refine?: { re: RegExp; kind: "list" | "span" }) => {
    if (claimed.has(slot) || !eligible.has(slot)) return;
    const focused = refine ? focus(clause, refine.re, refine.kind) : clause;
    const value = focused.trim().replace(/\s+/g, " ").slice(0, MAX_HARVEST_LEN);
    if (value.length < 4) return;
    claimed.add(slot);
    const secondFacet = PARTIAL_SLOTS[slot];
    out.push({
      slot,
      value: value.charAt(0).toUpperCase() + value.slice(1),
      verbatim: value,
      certainty: /\b(i think|maybe|around|about|roughly|probably|not sure|or so)\b/i.test(value)
        ? "approximate"
        : "stated",
      source: "patient",
      at,
      harvested: true,
      partial: secondFacet ? !secondFacet.test(text) : undefined,
    });
  };

  // Location needs a body site AND enough context that it is not incidental.
  const locationSlots = ["location", "acne_distribution", "hair_pattern"].filter((s) => eligible.has(s));
  if (locationSlots.length > 0) {
    const clause = firstMatchingClause(trimmed, LOCATION_RE);
    if (clause && LOCATION_RE.test(clause)) {
      claim(locationSlots[0], clause, { re: LOCATION_RE, kind: "list" });
    }
  }

  for (const signal of SIGNALS) {
    const target = signal.slots.find((s) => eligible.has(s) && !claimed.has(s));
    if (!target) continue;
    const clause = firstMatchingClause(trimmed, signal.test);
    if (clause && !(signal.reject && signal.reject.test(clause))) {
      claim(target, clause, signal.focus ? { re: signal.test, kind: signal.focus } : undefined);
    }
  }

  return out;
}

/**
 * Detects a patient raising several distinct problems in one answer. The
 * dermatologist needs to know this before they walk in, because it changes how
 * they budget the visit.
 */
export function countConcerns(text: string): number {
  const t = text.toLowerCase();
  const enumerated = t.match(/\b(two|three|four|several|a few|multiple|couple of)\s+(?:different\s+)?(?:things|issues|problems|concerns|spots|areas)\b/);
  if (enumerated) {
    const word = enumerated[1];
    const map: Record<string, number> = { two: 2, three: 3, four: 4, "a few": 3, several: 3, multiple: 3, "couple of": 2 };
    return map[word] ?? 2;
  }
  // "X, Y, and Z" where each segment names a distinct body site.
  const segments = t.split(/,\s*(?:and\s+)?|\s+and\s+/).filter((s) => s.trim().length > 6);
  const withSites = segments.filter((s) => LOCATION_RE.test(s));
  return withSites.length >= 3 ? withSites.length : 1;
}
