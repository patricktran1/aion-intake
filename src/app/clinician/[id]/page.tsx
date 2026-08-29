import { notFound } from "next/navigation";
import { bundleById, saveIntake } from "@/lib/store";
import { ageFrom, buildBrief, composeHpiDeterministic, headline } from "@/lib/ai/compose";
import { PATHWAY_LABELS } from "@/lib/domain/types";
import { BriefView, type BriefData } from "@/components/clinician/BriefView";
import { track } from "@/lib/analytics";

export const dynamic = "force-dynamic";

function durationLabel(startedAt?: string, submittedAt?: string): string {
  if (!startedAt || !submittedAt) return "duration not recorded";
  const secs = Math.round((new Date(submittedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  if (secs <= 0) return "duration not recorded";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `completed in ${m}m ${s}s` : `completed in ${s}s`;
}

export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bundle = bundleById(id);
  if (!bundle) notFound();

  let { intake } = bundle;
  // The brief is only generated once, on first read, and never regenerated
  // behind a physician's edits.
  if (!intake.hpi) {
    intake = saveIntake({
      ...intake,
      hpi: composeHpiDeterministic(bundle),
      hpiGenerated: composeHpiDeterministic(bundle),
    });
  }
  if (!intake.openedByClinicianAt) {
    intake = saveIntake({ ...intake, openedByClinicianAt: new Date().toISOString() });
  }
  track("clinician_brief_opened", {
    intake_id: intake.id,
    pathway: intake.pathway,
    photo_count: intake.photos.length,
  });

  const sections = buildBrief(intake).map((s) => ({
    label: s.label,
    items: s.items.map((i) => ({
      slot: i.slot,
      text: i.text,
      verbatim: i.verbatim,
      certainty: i.certainty,
    })),
  }));

  const data: BriefData = {
    id: intake.id,
    patientName: `${bundle.patient.firstName} ${bundle.patient.lastName}`,
    dateOfBirth: bundle.patient.dateOfBirth,
    age: ageFrom(bundle.patient.dateOfBirth),
    scheduledFor: bundle.visit.scheduledFor,
    reasonBooked: bundle.visit.reasonBooked,
    pathwayLabel: PATHWAY_LABELS[intake.pathway],
    headline: headline(intake),
    sections,
    photos: intake.photos.map((p) => ({
      id: p.id,
      dataUrl: p.dataUrl,
      caption: p.caption,
      kind: p.kind,
    })),
    openQuestions: intake.openQuestions,
    patientQuestions: intake.patientQuestions,
    hpi: intake.hpi,
    hpiSource: intake.aiUsage.mode === "model" ? "model" : "deterministic",
    review: intake.review,
    note: intake.note,
    urgentFlag: intake.urgentFlag,
    questionCount: intake.questionCount,
    durationLabel: durationLabel(intake.startedAt, intake.submittedAt),
    aiCostUsd: intake.aiUsage.estimatedCostUsd,
  };

  return <BriefView data={data} />;
}
