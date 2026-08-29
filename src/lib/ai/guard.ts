/**
 * Hallucination guard for generated narrative text.
 *
 * This is the single most important safety component in the product. A draft
 * HPI is only useful to a dermatologist if they can trust that every clinical
 * claim in it came from the patient. The guard is deliberately blunt: anything
 * it flags causes the caller to fall back to the deterministic composer, which
 * cannot invent anything by construction.
 */

export interface GuardViolation {
  kind:
    | "invented_negative"
    | "exam_finding"
    | "assessment_or_plan"
    | "unsourced_specific"
    | "diagnosis_language";
  detail: string;
}

/**
 * Phrases that assert a negative. A negative is a clinical claim: "denies fever"
 * means someone asked about fever. If the patient never said it, it is invented.
 */
const NEGATIVE_PATTERNS: RegExp[] = [
  /\bdenies\b/i,
  /\bno history of\b/i,
  /\bnegative for\b/i,
  /\bno known drug allergies\b/i,
  /\bnkda\b/i,
  /\bwithout\s+(fever|chills|pain|bleeding|systemic)/i,
  /\bnot\s+associated\s+with\b/i,
  /\bno\s+(fever|chills|weight loss|night sweats|systemic symptoms)\b/i,
];

/** Vocabulary that only a physical examination could produce. */
const EXAM_PATTERNS: RegExp[] = [
  /\bon (?:physical )?exam(?:ination)?\b/i,
  /\berythematous\b/i,
  /\bexcoriat/i,
  /\blichenif/i,
  /\bwell[- ]demarcated\b/i,
  /\bmacule|papule|plaque|pustule|nodule|vesicle|bulla/i,
  /\basymmetric border/i,
  /\bafebrile\b/i,
  /\bvital signs\b/i,
  /\bdermoscop/i,
  /\bpalpation\b/i,
];

/** Assessment and plan belong to the physician, after the encounter. */
const ASSESSMENT_PATTERNS: RegExp[] = [
  /\bassessment\s*:/i,
  /\bplan\s*:/i,
  /\bdifferential\b/i,
  /\bconsistent with\b/i,
  /\bsuggestive of\b/i,
  /\bmost likely represents\b/i,
  /\blikely (?:a|an|represents)\b/i,
  /\bconcerning for\b/i,
  /\brecommend(?:ed|s|ation)?\b/i,
  /\bwe (?:will|should) (?:start|prescribe|treat)\b/i,
  /\bprescrib/i,
  /\bbiopsy is\b/i,
  /\bdiagnos(?:is|ed|tic)\b/i,
  /\brule out\b/i,
];

/** Numbers and dates are the classic quiet fabrication. */
const SPECIFIC_PATTERNS: RegExp[] = [
  /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  /\b\d+\s?(mm|cm)\b/i,
];

const stripPunctuation = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ");

/**
 * @param text     Generated narrative to check.
 * @param sources  Everything the patient actually said (verbatim + values).
 */
export function guardNarrative(text: string, sources: string[]): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const sourceHay = stripPunctuation(sources.join(" \n "));

  const saidInSource = (fragment: string) =>
    sourceHay.includes(stripPunctuation(fragment).trim());

  for (const re of NEGATIVE_PATTERNS) {
    const m = text.match(re);
    // A negative is allowed only when the patient supplied that exact language.
    if (m && !saidInSource(m[0])) {
      violations.push({ kind: "invented_negative", detail: m[0] });
    }
  }
  for (const re of EXAM_PATTERNS) {
    const m = text.match(re);
    if (m && !saidInSource(m[0])) violations.push({ kind: "exam_finding", detail: m[0] });
  }
  for (const re of ASSESSMENT_PATTERNS) {
    const m = text.match(re);
    if (m) violations.push({ kind: "assessment_or_plan", detail: m[0] });
  }
  for (const re of SPECIFIC_PATTERNS) {
    const m = text.match(re);
    if (m && !saidInSource(m[0])) {
      violations.push({ kind: "unsourced_specific", detail: m[0] });
    }
  }
  return violations;
}

const DIAGNOSIS_WORDS = [
  "eczema", "psoriasis", "melanoma", "basal cell", "squamous cell", "rosacea",
  "tinea", "scabies", "lichen planus", "alopecia areata", "androgenetic",
  "seborrheic dermatitis", "contact dermatitis", "folliculitis", "hidradenitis",
];

/**
 * A diagnosis word is fine if the patient used it ("I was told it was eczema").
 * It is not fine if the summary introduced it.
 */
export function guardDiagnosisTerms(text: string, sources: string[]): GuardViolation[] {
  const sourceHay = stripPunctuation(sources.join(" "));
  const hay = stripPunctuation(text);
  return DIAGNOSIS_WORDS.filter((w) => hay.includes(w) && !sourceHay.includes(w)).map((w) => ({
    kind: "diagnosis_language" as const,
    detail: w,
  }));
}

export function guardAll(text: string, sources: string[]): GuardViolation[] {
  return [...guardNarrative(text, sources), ...guardDiagnosisTerms(text, sources)];
}

/**
 * A separate, tighter guard for the one piece of model text a patient reads:
 * the next question.
 *
 * The interview engine decides the subject; the model only re-voices it. So the
 * question must not contain advice, reassurance, a diagnosis, or a claim about
 * what the patient's skin is. Anything that trips this falls back to the
 * engine's own wording, which the patient cannot tell apart.
 */
const UNSAFE_QUESTION_PATTERNS: RegExp[] = [
  // Opinion about what the condition is — every phrasing shape.
  /\b(sounds? like|looks? like|appears? (?:to be|like)|seems? (?:to be|like)|that'?s likely|probably (is|just)|this (is|could be|might be) (a|an)|could this be|consistent with)\b/i,
  /\b(diagnos|assessment|prescrib|treatment plan)/i,
  // Advice, however phrased.
  /\byou should (try|use|apply|take|stop|see)\b/i,
  /\bi (recommend|suggest|would advise)\b/i,
  // A treatment SUGGESTION dressed as a question. "Have you tried anything" is
  // the engine's own legitimate question; "Have you tried hydrocortisone" is
  // the model recommending a drug.
  /\bhave you (tried|considered|thought about) (?!anything\b|something\b)/i,
  /\b(?:would|could) (?:a|an|some)\b.{0,30}\b(cream|ointment|gel|wash|pill|antibiotic|steroid)\b/i,
  // Reassurance, however phrased.
  /\b(don'?t worry|nothing to worry about|it'?s nothing serious|you'?ll be fine|probably fine|not (?:too )?serious|harmless|no need to (?:worry|panic)|nothing to be concerned)\b/i,
  /\b(urgent|emergency|serious|dangerous|cancer|malignan|benign)\b/i,
  /\bin my (opinion|experience)\b/i,
];

/**
 * @param sources The patient's own words so far. A diagnosis word the PATIENT
 *   used may be echoed back ("you mentioned eczema as a child — does this feel
 *   similar?"); one the model introduced is an opinion and is blocked.
 */
export function isSafeQuestion(text: string, sources: string[] = []): boolean {
  const t = text.trim();
  if (t.length < 8 || t.length > 320) return false;
  if (!t.includes("?")) return false;
  if (UNSAFE_QUESTION_PATTERNS.some((re) => re.test(t))) return false;
  // A named diagnosis the patient never said has no place in a question either.
  if (guardDiagnosisTerms(t, sources).length > 0) return false;
  return true;
}
