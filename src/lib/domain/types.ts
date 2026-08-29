import { z } from "zod";

/**
 * AION Intake domain model.
 *
 * Deliberately nine concepts, not twenty-seven. Everything here exists to move a
 * patient's story into a dermatologist's hands before the visit. Anything that
 * looks like billing, scheduling, charting, or longitudinal records is out of
 * scope (see SCOPE.md).
 */

export const PATHWAYS = ["rash", "lesion", "acne", "hair_loss", "general"] as const;
export type Pathway = (typeof PATHWAYS)[number];

export const PATHWAY_LABELS: Record<Pathway, string> = {
  rash: "Rash / dermatitis",
  lesion: "Spot of concern",
  acne: "Acne",
  hair_loss: "Hair loss",
  general: "General dermatology",
};

/**
 * How confident we are that a stored fact means what it says.
 *
 * `approximate` is load-bearing: when a patient says "I think around May", the
 * brief must keep the hedge instead of quietly promoting it to a date.
 */
export const CERTAINTY = ["stated", "approximate", "unclear"] as const;
export type Certainty = (typeof CERTAINTY)[number];

export const factSchema = z.object({
  slot: z.string(),
  /** Normalized, human-readable value used in the brief. */
  value: z.string(),
  /** The patient's own words that produced this value. Never rewritten. */
  verbatim: z.string(),
  certainty: z.enum(CERTAINTY),
  /** Always "patient" today. Exists so the UI can prove provenance. */
  source: z.literal("patient"),
  at: z.string(),
});
export type Fact = z.infer<typeof factSchema>;

export const messageSchema = z.object({
  id: z.string(),
  role: z.enum(["assistant", "patient"]),
  text: z.string(),
  at: z.string(),
  inputMode: z.enum(["text", "voice"]).optional(),
  /** Which slots the assistant turn was trying to fill. */
  targets: z.array(z.string()).default([]),
});
export type Message = z.infer<typeof messageSchema>;

export const photoSchema = z.object({
  id: z.string(),
  kind: z.enum(["wide", "close", "unspecified"]),
  mime: z.string(),
  bytes: z.number(),
  width: z.number(),
  height: z.number(),
  /** Downscaled, re-encoded JPEG. Re-encoding strips EXIF (incl. GPS). */
  dataUrl: z.string(),
  caption: z.string().default(""),
  /** Non-diagnostic capture advisories only. Never a clinical statement. */
  advisories: z.array(z.string()).default([]),
  at: z.string(),
});
export type Photo = z.infer<typeof photoSchema>;

export const aiUsageSchema = z.object({
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  estimatedCostUsd: z.number(),
  model: z.string(),
  /** "deterministic" when no model was used at all. */
  mode: z.enum(["deterministic", "model"]),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

export const clinicianReviewSchema = z.object({
  exam: z.string().default(""),
  assessment: z.string().default(""),
  plan: z.string().default(""),
  medications: z.string().default(""),
  followUp: z.string().default(""),
  updatedAt: z.string().optional(),
});
export type ClinicianReview = z.infer<typeof clinicianReviewSchema>;

export const INTAKE_STATUSES = [
  "not_started",
  "in_progress",
  "ready_for_review",
  "reviewed",
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const intakeSchema = z.object({
  id: z.string(),
  /** Unguessable, single-purpose link for the patient. */
  token: z.string(),
  visitId: z.string(),
  status: z.enum(INTAKE_STATUSES),
  pathway: z.custom<Pathway>(),
  messages: z.array(messageSchema),
  facts: z.array(factSchema),
  photos: z.array(photoSchema),
  /** Slots the interview asked about but could not resolve. */
  openQuestions: z.array(z.string()),
  /** Things the patient explicitly asked us to raise with the doctor. */
  patientQuestions: z.array(z.string()),
  askedSlots: z.array(z.string()),
  questionCount: z.number(),
  startedAt: z.string().optional(),
  submittedAt: z.string().optional(),
  lastActivityAt: z.string(),
  voiceTurns: z.number(),
  textTurns: z.number(),
  aiUsage: aiUsageSchema,
  /** Physician-editable. Regenerated only on explicit request. */
  hpi: z.string().default(""),
  hpiGenerated: z.string().default(""),
  hpiEditedByClinician: z.boolean().default(false),
  review: clinicianReviewSchema,
  note: z.string().default(""),
  /** Set when the interview detects language that warrants urgent care advice. */
  urgentFlag: z.boolean().default(false),
  openedByClinicianAt: z.string().optional(),
});
export type Intake = z.infer<typeof intakeSchema>;

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  /** Demo only. Real deployments should link to the practice's own record. */
  dateOfBirth: string;
  pronouns?: string;
}

export interface Practice {
  id: string;
  name: string;
  clinicianName: string;
  clinicianCredential: string;
}

export interface Visit {
  id: string;
  practiceId: string;
  patientId: string;
  scheduledFor: string;
  reasonBooked: string;
  location: string;
}

export interface IntakeBundle {
  intake: Intake;
  visit: Visit;
  patient: Patient;
  practice: Practice;
}
