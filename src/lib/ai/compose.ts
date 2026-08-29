import type { Fact, Intake, IntakeBundle, Pathway } from "@/lib/domain/types";
import { PATHWAY_LABELS } from "@/lib/domain/types";
import { sanitizeText, stripFiller, stripSelfReference, truncate } from "@/lib/interview/engine";
import { guardAll, type GuardViolation } from "./guard";

/**
 * Deterministic composition of the physician-facing artefacts.
 *
 * These functions are the floor the product stands on: they produce a usable
 * brief and a usable draft HPI with no model involved at all. When a model is
 * configured it rewrites the HPI into smoother prose, but only if the result
 * survives the guard — otherwise this output ships instead.
 */

export interface BriefSection {
  label: string;
  /** Rendered lines. Each carries the patient's own words for provenance. */
  items: BriefItem[];
}

export interface BriefItem {
  text: string;
  verbatim: string;
  certainty: Fact["certainty"];
  slot: string;
  /** Volunteered in a longer answer rather than given to a direct question. */
  harvested: boolean;
}

export const sourcesFrom = (facts: Fact[]): string[] =>
  facts.flatMap((f) => [f.verbatim, f.value]);

/**
 * A bare negative is real information — we asked, and the patient said no — but
 * rendered raw it produces brief rows reading "Relevant context: Nothing".
 * Normalising it keeps the meaning and makes it read like a record.
 */
const BARE_NEGATIVE = /^(no|nope|none|nothing|nothing really|not really|nah|no thanks|n\/a)[.!]?$/i;

const NEGATIVE_PHRASING: Record<string, string> = {
  treatments: "Nothing tried",
  acne_treatments: "Nothing tried",
  context: "None reported",
  atopy: "None reported",
  lesion_others: "No other spots raised",
  sun_history: "None reported",
  symptoms: "No symptoms reported",
  lesion_symptoms: "No symptoms reported",
  hair_scalp: "No scalp symptoms reported",
  triggers: "None identified by the patient",
  exposures: "None identified by the patient",
  acne_pattern: "No pattern identified by the patient",
  hair_stressors: "None identified by the patient",
  hair_care: "Nothing unusual reported",
};

export function renderFactValue(fact: Fact): string {
  const v = fact.value.trim();
  if (BARE_NEGATIVE.test(v)) return NEGATIVE_PHRASING[fact.slot] ?? "None reported";
  return v;
}

/** Two values say the same thing when one is contained in the other. */
function overlaps(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

function itemsFor(intake: Intake, slotIds: string[]): BriefItem[] {
  return intake.facts
    .filter((f) => slotIds.includes(f.slot) && f.value.trim())
    .map((f) => ({
      // A patient who tells their whole story in the opening answer should get
      // a readable concern line, not a paragraph. The full text is still on the
      // item as `verbatim`, so nothing is lost — it moves behind "show the
      // patient's own words", which is where a wall of text belongs.
      text: f.slot === "concern" ? cleanConcern(f.value) : renderFactValue(f),
      verbatim: f.verbatim,
      certainty: f.certainty,
      slot: f.slot,
      harvested: f.harvested === true,
    }));
}

/**
 * Section layout, per pathway.
 *
 * Each pathway gets its own map so no two slots ever share a label. Sharing was
 * producing three consecutive "Relevant context" rows on a lesion brief, two of
 * which were bare negatives, which is exactly the noise this section is meant
 * to be free of.
 */
const SECTIONS: Record<Pathway, { label: string; slots: string[] }[]> = {
  rash: [
    { label: "Primary concern", slots: ["concern"] },
    { label: "Location", slots: ["location"] },
    { label: "Timeline", slots: ["timeline"] },
    { label: "Symptoms", slots: ["symptoms"] },
    { label: "Triggers", slots: ["triggers"] },
    { label: "New exposures", slots: ["exposures"] },
    { label: "Tried so far", slots: ["treatments"] },
    { label: "Atopic history", slots: ["atopy"] },
    { label: "Medications, allergies, history", slots: ["context"] },
    { label: "Patient goal", slots: ["goal"] },
  ],
  lesion: [
    { label: "Primary concern", slots: ["concern"] },
    { label: "Location", slots: ["location"] },
    { label: "Timeline and change", slots: ["lesion_timeline"] },
    { label: "Symptoms", slots: ["lesion_symptoms"] },
    { label: "Sun and skin-cancer history", slots: ["sun_history"] },
    { label: "Other spots", slots: ["lesion_others"] },
    { label: "Tried so far", slots: ["treatments"] },
    { label: "Medications, allergies, history", slots: ["context"] },
    { label: "Patient goal", slots: ["goal"] },
  ],
  acne: [
    { label: "Primary concern", slots: ["concern"] },
    { label: "Distribution", slots: ["acne_distribution"] },
    { label: "Timeline", slots: ["timeline"] },
    { label: "Tried so far", slots: ["acne_treatments"] },
    { label: "Flare pattern", slots: ["acne_pattern"] },
    { label: "Impact", slots: ["acne_impact"] },
    { label: "Medications, allergies, history", slots: ["context"] },
    { label: "Patient goal", slots: ["goal"] },
  ],
  hair_loss: [
    { label: "Primary concern", slots: ["concern"] },
    { label: "Pattern", slots: ["hair_pattern"] },
    { label: "Timeline", slots: ["timeline"] },
    { label: "Scalp symptoms", slots: ["hair_scalp"] },
    { label: "Preceding events", slots: ["hair_stressors"] },
    { label: "Hair care", slots: ["hair_care"] },
    { label: "Tried so far", slots: ["treatments"] },
    { label: "Medications, allergies, history", slots: ["context"] },
    { label: "Patient goal", slots: ["goal"] },
  ],
  general: [
    { label: "Primary concern", slots: ["concern"] },
    { label: "Location", slots: ["location"] },
    { label: "Timeline", slots: ["timeline"] },
    { label: "Symptoms", slots: ["symptoms"] },
    { label: "Triggers", slots: ["triggers"] },
    { label: "Tried so far", slots: ["treatments"] },
    { label: "Medications, allergies, history", slots: ["context"] },
    { label: "Patient goal", slots: ["goal"] },
  ],
};

/**
 * The brief is assembled from whichever slots the pathway actually filled.
 * Empty sections are dropped rather than padded — a section that says "none
 * reported" when nobody asked would be an invented negative.
 */
export function buildBrief(intake: Intake): BriefSection[] {
  // Patients repeat themselves, and a patient who answers three questions with
  // the same sentence should not produce three identical rows. The first
  // section to carry a value keeps it; later duplicates are dropped, because a
  // brief whose rows all read the same is one a dermatologist stops trusting.
  const seen = new Set<string>();
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  return SECTIONS[intake.pathway]
    .map((g) => ({
      label: g.label,
      items: itemsFor(intake, g.slots).filter((item) => {
        const k = key(item.text);
        if (k.length < 12) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }),
    }))
    .filter((s) => s.items.length > 0);
}

/**
 * High-value things the intake did not establish, named explicitly.
 *
 * A physician reading a brief has to be able to tell "asked, patient said no"
 * apart from "never asked". Silence looks like a negative, and that is the
 * quietest way a summary can mislead.
 */
export function notEstablished(intake: Intake): string[] {
  const answered = new Set(
    intake.facts.filter((f) => f.value.trim().length > 0).map((f) => f.slot),
  );
  return SECTIONS[intake.pathway]
    .filter((g) => g.slots.every((sl) => !answered.has(sl)))
    .filter((g) => g.label !== "Primary concern")
    .map((g) => g.label);
}

/** First sentence, filler removed — what the concern would look like tidied. */
const CONCERN_MAX = 120;

/**
 * The concern, reduced to something a dermatologist can read in one line.
 *
 * Patients often answer the opening question with three hundred unpunctuated
 * characters. Clipping that mid-word produces a headline that looks broken and
 * says nothing, so this cuts at a real clause boundary and only falls back to
 * an ellipsis when there is no boundary to cut at.
 */
export function cleanConcern(raw: string): string {
  const stripped = stripSelfReference(stripFiller(sanitizeText(raw)).replace(/\s+/g, " ").trim());
  const firstSentence = stripped.split(/(?<=[.!?])\s+/)[0] ?? stripped;
  const candidate = (firstSentence.length >= 25 ? firstSentence : stripped).replace(/[,;.!]+\s*$/, "");
  if (candidate.length <= CONCERN_MAX) return candidate;

  // Cut at the last clause boundary that still leaves a useful line.
  const window = candidate.slice(0, CONCERN_MAX);
  const boundary = Math.max(
    window.lastIndexOf(", "),
    window.lastIndexOf("; "),
    window.lastIndexOf(" and "),
    window.lastIndexOf(" but "),
  );
  if (boundary > 45) return window.slice(0, boundary).replace(/[,;]\s*$/, "").trim();
  return truncate(candidate, CONCERN_MAX);
  // truncate() is surrogate-safe, so the ellipsis fallback never splits an emoji.
}

/**
 * One line a dermatologist can read while opening the door.
 *
 * The timeline is appended only when it genuinely adds something: not when the
 * concern already carries a duration, and never when the patient was unsure,
 * because "dark spot — honestly no idea" is a worse headline than "dark spot".
 */
export function headline(intake: Intake): string {
  const concern = intake.facts.find((f) => f.slot === "concern");
  const timeline = intake.facts.find(
    (f) => (f.slot === "timeline" || f.slot === "lesion_timeline") && f.certainty !== "unclear",
  );
  const base = concern ? cleanConcern(concern.value) : PATHWAY_LABELS[intake.pathway];
  if (!timeline) return base;

  const DURATION_WORD = /\b(year|month|week|day)s?\b|\bsince\b/i;
  if (DURATION_WORD.test(base) && DURATION_WORD.test(timeline.value)) return base;
  if (overlaps(base, timeline.value)) return base;

  const suffix = headlineTimeline(renderFactValue(timeline));
  return suffix ? `${base} — ${suffix}` : base;
}

/**
 * A headline suffix has to be a whole thought. Truncating a long timeline
 * mid-word ("…darker and larger than bef…") looks broken and tells the reader
 * nothing, so a clause that will not fit is dropped rather than clipped.
 */
const QUANTITY = "(?:\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|couple|several|many)";
const UNIT = "(?:day|week|month|year)s?";
const APPROX = "(?:about|around|roughly|nearly|over|almost)?";
const DURATION_CLAUSE = new RegExp(
  [
    // "for years", "for about three months" — quantity optional after "for".
    `\\bfor\\s+${APPROX}\\s*${QUANTITY}?\\s*${UNIT}\\b`,
    // "three months", "a couple of weeks"
    `\\b${APPROX}\\s*${QUANTITY}\\s*(?:-|\\s)?${UNIT}\\b`,
    // "since May", "since childhood"
    "\\bsince\\s+[a-z]+\\b",
  ].join("|"),
  "i",
);

export function headlineTimeline(value: string): string | null {
  const first = (value.split(/[;.]/)[0] ?? value).trim();
  if (first.length > 0 && first.length <= 62) return first;
  const m = value.match(DURATION_CLAUSE);
  return m ? m[0].trim() : null;
}

/**
 * Hedge language is carried through from the patient's certainty rating so the
 * physician can see uncertainty rather than inherit false precision.
 */
function phrase(fact: Fact): string {
  const v = renderFactValue(fact).replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (fact.certainty === "approximate") return `${v} (patient's approximation)`;
  if (fact.certainty === "unclear") return `${v} (patient unsure)`;
  return v;
}

/**
 * Deterministic draft HPI.
 *
 * A prose opening sentence a physician can read at a glance, then one
 * attributed line per thing the patient actually said, then an explicit list of
 * what the intake did not establish. Nothing is added, nothing is negated, and
 * absence is stated rather than left to be misread as a negative.
 */
export function composeHpiDeterministic(bundle: IntakeBundle): string {
  const { intake, patient } = bundle;
  const lines: string[] = [];
  const age = ageFrom(patient.dateOfBirth);
  const who = age ? `${age}-year-old patient` : "Patient";

  const concern = intake.facts.find((f) => f.slot === "concern");
  if (concern) {
    const clean = cleanConcern(concern.value);
    if (READS_AS_SENTENCE.test(clean)) {
      // "presents for evaluation of I think this is eczema" is not English.
      // A first-person concern is quoted instead of being inlined.
      lines.push(`${who} presents for a dermatology visit.`);
      lines.push(`In their own words: "${truncate(concern.verbatim.trim(), 500)}"`);
    } else {
      lines.push(`${who} presents for evaluation of ${lowerFirst(clean)}.`);
      const verbatim = concern.verbatim.trim();
      if (!overlaps(verbatim, clean) || verbatim.length > 160) {
        lines.push(`In their own words: "${truncate(verbatim, 500)}"`);
      }
    }
  } else {
    lines.push(`${who} presents for a dermatology visit.`);
  }
  lines.push("");

  const rendered = new Set<string>();
  const seenValues = new Set<string>();
  for (const group of SECTIONS[intake.pathway]) {
    if (group.slots.includes("concern") || group.slots.includes("goal")) continue;
    for (const slotId of group.slots) {
      for (const f of intake.facts.filter((x) => x.slot === slotId && x.value.trim())) {
        const line = `${group.label}: ${phrase(f)}.`;
        if (rendered.has(line)) continue;
        const valueKey = f.value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        if (valueKey.length >= 12 && seenValues.has(valueKey)) continue;
        seenValues.add(valueKey);
        rendered.add(line);
        lines.push(line);
      }
    }
  }

  const goal = intake.facts.find((f) => f.slot === "goal");
  if (goal) {
    const goalKey = goal.value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (goalKey.length < 12 || !seenValues.has(goalKey)) {
      lines.push("");
      lines.push(`Patient's stated goal for the visit: ${phrase(goal)}.`);
    }
  }

  const missing = notEstablished(intake);
  if (missing.length > 0) {
    lines.push("");
    lines.push(`Not established during intake: ${missing.join("; ")}.`);
  }

  if (intake.photos.length > 0) {
    lines.push(
      `${intake.photos.length} patient-supplied reference photograph${intake.photos.length > 1 ? "s" : ""} attached for review.`,
    );
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A concern that is already a clause with a subject cannot be inlined. */
const READS_AS_SENTENCE =
  /^(i|we|my|there(?:'s| is| are)|it(?:'s| is)|he|she|they|the doctor|patient)\b/i;

function lowerFirst(s: string): string {
  if (!s) return s;
  // Leave acronyms and proper nouns alone.
  if (s.length > 1 && s[1] === s[1].toUpperCase() && /[A-Z]/.test(s[1])) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Accepts a model-written HPI only if it survives the guard. Returns the
 * deterministic version otherwise, along with the reason.
 */
export function acceptOrFallbackHpi(
  candidate: string,
  bundle: IntakeBundle,
): { text: string; accepted: boolean; violations: GuardViolation[] } {
  const sources = sourcesFrom(bundle.intake.facts);
  const violations = guardAll(candidate, sources);
  if (violations.length > 0 || candidate.trim().length < 40) {
    return { text: composeHpiDeterministic(bundle), accepted: false, violations };
  }
  return { text: candidate.trim(), accepted: true, violations: [] };
}

export function ageFrom(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/**
 * The final note. Patient-supplied history and physician-supplied findings are
 * kept in separate, labelled blocks — the AI formats, it never authors the
 * clinical half.
 */
export function composeNote(bundle: IntakeBundle): string {
  const { intake, patient, practice, visit } = bundle;
  const { review } = intake;
  const out: string[] = [];
  out.push(`${practice.name} — dermatology encounter note (DRAFT)`);
  out.push(`Patient: ${patient.firstName} ${patient.lastName}   DOB: ${patient.dateOfBirth}`);
  out.push(`Date of service: ${new Date(visit.scheduledFor).toLocaleDateString("en-US")}`);
  out.push(`Clinician: ${practice.clinicianName}, ${practice.clinicianCredential}`);
  out.push("");
  out.push("HISTORY OF PRESENT ILLNESS (patient-supplied, reviewed by clinician)");
  out.push(intake.hpi.trim() || composeHpiDeterministic(bundle));
  if (review.exam.trim()) {
    out.push("");
    out.push("EXAMINATION (clinician-entered)");
    out.push(review.exam.trim());
  }
  if (review.assessment.trim()) {
    out.push("");
    out.push("ASSESSMENT (clinician-entered)");
    out.push(review.assessment.trim());
  }
  if (review.plan.trim() || review.medications.trim()) {
    out.push("");
    out.push("PLAN (clinician-entered)");
    if (review.plan.trim()) out.push(review.plan.trim());
    if (review.medications.trim()) {
      out.push(`Medications discussed: ${review.medications.trim()}`);
      out.push("(Not transmitted to any pharmacy. AION Intake does not prescribe.)");
    }
  }
  if (review.followUp.trim()) {
    out.push("");
    out.push("FOLLOW-UP (clinician-entered)");
    out.push(review.followUp.trim());
  }
  out.push("");
  out.push(
    "Draft generated by AION Intake from patient-supplied pre-visit history and clinician-entered findings. Review and edit before entering into the medical record.",
  );
  return out.join("\n");
}
