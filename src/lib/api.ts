import { NextResponse } from "next/server";
import type { Intake, IntakeBundle } from "@/lib/domain/types";
import { buildBrief, headline } from "@/lib/ai/compose";
import { findSlot } from "@/lib/interview/engine";

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status });
export const fail = (message: string, status = 400) =>
  NextResponse.json({ error: message }, { status });

/**
 * What the patient's browser is allowed to see. Notably absent: anything about
 * other patients, the clinician's notes, or internal slot planning.
 */
export function patientView(bundle: IntakeBundle) {
  const { intake, visit, patient, practice } = bundle;
  const lastAssistant = [...intake.messages].reverse().find((m) => m.role === "assistant");
  return {
    token: intake.token,
    status: intake.status,
    pathway: intake.pathway,
    questionCount: intake.questionCount,
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
      dataUrl: p.dataUrl,
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
export function listRow(bundle: IntakeBundle) {
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
    token: intake.token,
  };
}

export function ensureBundle(bundle: IntakeBundle | null): bundle is IntakeBundle {
  return bundle !== null;
}

export function isSubmitted(intake: Intake): boolean {
  return intake.status === "ready_for_review" || intake.status === "reviewed";
}
