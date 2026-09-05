import { NextResponse } from "next/server";
import type { Intake, IntakeBundle } from "@/lib/domain/types";
import { buildBrief, headline } from "@/lib/ai/compose";
import { estimateRemaining, findSlot } from "@/lib/interview/engine";

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/**
 * What the patient's browser is allowed to see. Notably absent: anything about
 * other patients, the clinician's notes, or internal slot planning.
 */
export function patientView(bundle: IntakeBundle, opts: { token?: string } = {}) {
  const { intake, visit, patient, practice } = bundle;
  // In pilot mode a photo's dataUrl is the clinician-only bytes route. The
  // patient reviews their own uploads on the same screen, so rewrite those to
  // the token-scoped view path — the token in the URL is the patient's
  // credential, the same one every other patient request carries.
  const photoUrl = (dataUrl: string, id: string) =>
    opts.token && dataUrl.startsWith("/api/intake/photo/")
      ? `/api/intake/${opts.token}/photos/${id}`
      : dataUrl;
  const lastAssistant = [...intake.messages].reverse().find((m) => m.role === "assistant");
  return {
    token: intake.token,
    status: intake.status,
    pathway: intake.pathway,
    questionCount: intake.questionCount,
    /** Best current guess at what is left. Shrinks as the patient volunteers more. */
    remaining: estimateRemaining(intake),
    urgentFlag: intake.urgentFlag,
    messages: intake.messages.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      inputMode: m.inputMode ?? null,
    })),
    currentSlot: lastAssistant?.targets[0] ?? null,
    chips: lastAssistant?.targets[0]
      ? (findSlot(intake.pathway, lastAssistant.targets[0])?.chips ?? [])
      : [],
    hint: lastAssistant?.targets[0]
      ? (findSlot(intake.pathway, lastAssistant.targets[0])?.hint ?? null)
      : null,
    photos: intake.photos.map((p) => ({
      id: p.id,
      dataUrl: photoUrl(p.dataUrl, p.id),
      caption: p.caption,
      advisories: p.advisories,
    })),
    summary: buildBrief(intake).map((s) => ({
      label: s.label,
      items: s.items.map((i) => ({ slot: i.slot, text: i.text, certainty: i.certainty })),
    })),
    patient: { firstName: patient.firstName },
    practice: { name: practice.name, clinicianName: practice.clinicianName },
    visit: { scheduledFor: visit.scheduledFor, location: visit.location, reasonBooked: visit.reasonBooked },
  };
}

export type PatientView = ReturnType<typeof patientView>;

/** Clinician list row. Enough to triage, not enough to be a chart. */
/**
 * @param opts.includeToken demo only. The demo worklist offers "Open link" so a
 *   founder can hand over the phone; a pilot must never put a patient's access
 *   credential on a clinician's screen or in a clinician's API response. In
 *   pilot the value is not even a credential — the real token exists only as a
 *   peppered hash — so shipping it was a token-shaped string that means nothing,
 *   which is its own small trap for anyone who finds it in a log.
 */
export function listRow(bundle: IntakeBundle, opts: { includeToken?: boolean } = {}) {
  const { intake, visit, patient } = bundle;
  return {
    id: intake.id,
    patientName: `${patient.firstName} ${patient.lastName}`,
    dateOfBirth: patient.dateOfBirth,
    scheduledFor: visit.scheduledFor,
    reasonBooked: visit.reasonBooked,
    concern: headline(intake),
    pathway: intake.pathway,
    status: intake.status,
    photoCount: intake.photos.length,
    openQuestionCount: intake.openQuestions.length + intake.patientQuestions.length,
    urgentFlag: intake.urgentFlag,
    ...(opts.includeToken ? { token: intake.token } : {}),
  };
}

export function ensureBundle(bundle: IntakeBundle | null): bundle is IntakeBundle {
  return bundle !== null;
}

export function isSubmitted(intake: Intake): boolean {
  return intake.status === "ready_for_review" || intake.status === "reviewed";
}
