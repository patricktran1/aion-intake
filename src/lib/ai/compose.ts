import type { Fact, Intake, IntakeBundle } from "@/lib/domain/types";
import { PATHWAY_LABELS } from "@/lib/domain/types";
import { findSlot, truncate } from "@/lib/interview/engine";
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
}

export const sourcesFrom = (facts: Fact[]): string[] =>
  facts.flatMap((f) => [f.verbatim, f.value]);

function itemsFor(intake: Intake, slotIds: string[]): BriefItem[] {
  return intake.facts
    .filter((f) => slotIds.includes(f.slot) && f.value.trim())
    .map((f) => ({ text: f.value, verbatim: f.verbatim, certainty: f.certainty, slot: f.slot }));
}

/**
 * The brief is assembled from whichever slots the pathway actually filled.
 * Empty sections are dropped rather than padded — a section that says "none
 * reported" would be an invented negative.
 */
export function buildBrief(intake: Intake): BriefSection[] {
  const groups: { label: string; slots: string[] }[] = [
    { label: "Primary concern", slots: ["concern"] },
    { label: "Location", slots: ["location", "acne_distribution", "hair_pattern"] },
    { label: "Timeline", slots: ["timeline", "lesion_timeline"] },
    {
      label: "Symptoms",
      slots: ["symptoms", "lesion_symptoms", "hair_scalp"],
    },
    {
      label: "Triggers and exposures",
      slots: ["triggers", "exposures", "acne_pattern", "hair_stressors", "hair_care"],
    },
    { label: "Tried so far", slots: ["treatments", "acne_treatments"] },
    { label: "Impact on daily life", slots: ["acne_impact"] },
    {
      label: "Relevant context",
      slots: ["context", "atopy", "sun_history", "lesion_others"],
    },
    { label: "Patient goal", slots: ["goal"] },
  ];

  return groups
    .map((g) => ({ label: g.label, items: itemsFor(intake, g.slots) }))
    .filter((s) => s.items.length > 0);
}

/** One line a dermatologist can read while opening the door. */
export function headline(intake: Intake): string {
  const concern = intake.facts.find((f) => f.slot === "concern");
  const timeline = intake.facts.find((f) => f.slot === "timeline" || f.slot === "lesion_timeline");
  const base = concern ? truncate(concern.value, 130) : PATHWAY_LABELS[intake.pathway];
  if (!timeline) return base;
  // Skip the timeline clause when the opening answer already carried it — the
  // headline has one job and repeating "for about a year" twice wastes it.
  const already = /\b(year|month|week|day)s?\b/i.test(base) && /\b(year|month|week|day)s?\b/i.test(timeline.value);
  if (already) return base;
  return `${base} — ${truncate(timeline.value, 70)}`;
}

const label = (intake: Intake, slotId: string) =>
  findSlot(intake.pathway, slotId)?.briefLabel ?? slotId;

/**
 * Hedge language is carried through from the patient's certainty rating so the
 * physician can see uncertainty rather than inherit false precision.
 */
function phrase(fact: Fact): string {
  const v = fact.value.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (fact.certainty === "approximate") return `${v} (patient's approximation)`;
  if (fact.certainty === "unclear") return `${v} (patient unsure)`;
  return v;
}

/**
 * Deterministic draft HPI.
 *
 * Structure: who, what they came for, then each filled slot as an attributed
 * sentence. Nothing is added. Nothing is negated. If a slot is empty it simply
 * does not appear.
 */
export function composeHpiDeterministic(bundle: IntakeBundle): string {
  const { intake, patient } = bundle;
  const lines: string[] = [];
  const age = ageFrom(patient.dateOfBirth);
  const who = age ? `${age}-year-old patient` : "Patient";

  const concern = intake.facts.find((f) => f.slot === "concern");
  if (concern) {
    lines.push(`${who} presents for evaluation of the following, in their words: "${concern.verbatim.trim()}"`);
  } else {
    lines.push(`${who} presents for a dermatology visit.`);
  }

  const ordered = [
    "location", "acne_distribution", "hair_pattern",
    "timeline", "lesion_timeline",
    "symptoms", "lesion_symptoms", "hair_scalp",
    "triggers", "exposures", "acne_pattern", "hair_stressors", "hair_care",
    "treatments", "acne_treatments",
    "acne_impact", "atopy", "sun_history", "context", "lesion_others",
  ];

  for (const slotId of ordered) {
    const facts = intake.facts.filter((f) => f.slot === slotId && f.value.trim());
    for (const f of facts) {
      lines.push(`${label(intake, slotId)}: ${phrase(f)}.`);
    }
  }

  const goal = intake.facts.find((f) => f.slot === "goal");
  if (goal) {
    lines.push(`Patient's stated goal for the visit: ${phrase(goal)}.`);
  }

  if (intake.photos.length > 0) {
    lines.push(
      `${intake.photos.length} patient-supplied reference photograph${intake.photos.length > 1 ? "s" : ""} attached for review.`,
    );
  }

  return lines.join("\n");
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
