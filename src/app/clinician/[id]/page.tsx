import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { bundleById, saveIntake, store } from "@/lib/store";
import { isPilot } from "@/lib/config/runtime";
import { requireClinician } from "@/lib/auth/guard";
import { audit } from "@/lib/audit";
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

/**
 * The brief.
 *
 * Like the worklist, this page read the in-memory helper and had no
 * authentication: in pilot mode it 404'd for every intake, and had it found
 * one it would have shown a stranger's dermatology history. It now requires a
 * signed-in clinician, reads through the tenant-scoped query, and writes the
 * first-read HPI through the same row lock every other pilot write uses — a
 * page rendering twice must not generate two briefs.
 */
export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const pilot = isPilot();
  const ctx = pilot ? await requireClinician().catch(() => null) : null;
  if (pilot && !ctx) redirect("/clinician/sign-in");

  const s = pilot ? await store() : null;
  // Scoped by practice in the WHERE clause. Another practice's intake comes
  // back as null and renders the same 404 as one that does not exist.
  const bundle = pilot ? await s!.bundleForClinician(id, ctx!.practiceId) : bundleById(id);
  if (!bundle) notFound();

  let { intake } = bundle;
  // The brief is only generated once, on first read, and never regenerated
  // behind a physician's edits.
  //
  // This is a GET that writes, which is a shape worth being uncomfortable
  // about: a cross-site `<img src="/clinician/int_x">` in a signed-in
  // clinician's browser would fire it, and a page navigation carries no CSRF
  // token to check. Three things make it safe rather than merely unexploited,
  // and they are the reasons it stays a GET rather than becoming a POST the
  // page has no way to send:
  //
  //   - It is idempotent. The HPI is generated only when absent and the
  //     timestamp only when null, so the tenth forged request writes nothing.
  //   - It composes deterministically from the patient's own answers. There is
  //     no attacker-supplied input and no model call, so a forged read cannot
  //     put anything into the record.
  //   - Tenancy still holds: bundleForClinician scopes by the session's
  //     practice, so a forged request cannot reach another practice's intake.
  //
  // What an attacker gets is an audit row saying this clinician opened this
  // brief — a false entry in a trail whose whole value is being true. So the
  // audit records where the request came from, and a read this page did not
  // originate is visible as such rather than indistinguishable from a real one.
  if (pilot) {
    intake = await s!.withIntake(id, async (current) => {
      const next = {
        ...current,
        hpi: current.hpi || composeHpiDeterministic({ ...bundle, intake: current }),
        hpiGenerated: current.hpiGenerated || composeHpiDeterministic({ ...bundle, intake: current }),
        openedByClinicianAt: current.openedByClinicianAt ?? new Date().toISOString(),
      };
      const changed =
        next.hpi !== current.hpi ||
        next.hpiGenerated !== current.hpiGenerated ||
        next.openedByClinicianAt !== current.openedByClinicianAt;
      return { intake: changed ? next : null, result: next };
    });
    await audit({
      action: "brief.opened",
      actor: ctx!.actor,
      practiceId: ctx!.practiceId,
      resource: "intake",
      resourceId: id,
      // A same-origin navigation is the clinician opening the brief. Anything
      // else is a request their browser was made to send, and the trail should
      // say so rather than record it as a genuine read.
      meta: { origin: (await headers()).get("sec-fetch-site") ?? "unknown" },
    });
  } else {
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
    // Demo only. See BriefView for why a cost figure has no place on a
    // clinician's screen during a real encounter.
    showCost: !pilot,
    // Read from the signed session and handed to the client, because the
    // cookie is HttpOnly and the browser cannot read it. Without this the
    // double-submit check refuses every clinician write.
    csrf: ctx?.session.csrf ?? null,
  };

  return <BriefView data={data} />;
}
