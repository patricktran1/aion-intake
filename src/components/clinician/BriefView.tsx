"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Brand } from "@/components/Brand";
import { CopyButton } from "./CopyButton";
import type { ClinicianReview } from "@/lib/domain/types";

export interface BriefData {
  id: string;
  patientName: string;
  dateOfBirth: string;
  age: number | null;
  scheduledFor: string;
  reasonBooked: string;
  pathwayLabel: string;
  headline: string;
  sections: {
    label: string;
    items: { slot: string; text: string; verbatim: string; certainty: string }[];
  }[];
  photos: { id: string; dataUrl: string; caption: string; kind: string }[];
  openQuestions: string[];
  patientQuestions: string[];
  hpi: string;
  hpiSource: "deterministic" | "model";
  review: ClinicianReview;
  note: string;
  urgentFlag: boolean;
  questionCount: number;
  durationLabel: string;
  aiCostUsd: number;
}

/**
 * The pre-visit brief.
 *
 * The whole screen is built around one question: can a dermatologist understand
 * this patient in thirty seconds? Hence the single headline, the scannable
 * two-column body, and "clarify in visit" pulled out where it cannot be missed.
 */
/** Fire-and-forget client analytics. Never blocks or surfaces an error. */
function report(event: string, intakeId: string) {
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, intakeId }),
  }).catch(() => {});
}

/**
 * Grows a textarea to fit its content.
 *
 * The draft HPI is the thing a physician is judging. Making them scroll inside
 * a box to read it is friction on exactly the wrong action, and it hides how
 * long the note actually is.
 */
function useAutoSize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return ref;
}

export function BriefView({ data }: { data: BriefData }) {
  const [hpi, setHpi] = useState(data.hpi);
  const [review, setReview] = useState<ClinicianReview>(data.review);
  const [note, setNote] = useState(data.note);
  const [showWords, setShowWords] = useState(false);
  const hpiRef = useAutoSize(hpi);
  const noteRef = useAutoSize(note);
  const [saving, setSaving] = useState<null | "hpi" | "review" | "note">(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>, kind: "hpi" | "review") {
    setSaving(kind);
    await fetch(`/api/clinician/intakes/${data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(null);
    setSaved(kind);
    setTimeout(() => setSaved(null), 2000);
  }

  async function generateNote() {
    setSaving("note");
    await fetch(`/api/clinician/intakes/${data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hpi, review }),
    });
    const res = await fetch(`/api/clinician/intakes/${data.id}/note`, { method: "POST" });
    const body = await res.json();
    setNote(body.note ?? "");
    setSaving(null);
  }

  const when = new Date(data.scheduledFor).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="min-h-dvh-safe">
      <header className="sticky top-0 z-10 border-b hairline bg-surface no-print">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3.5">
          <div className="flex items-center gap-4">
            <Link href="/clinician" className="text-[14px] text-muted transition hover:text-ink">
              ← All visits
            </Link>
            <span className="hidden h-4 w-px bg-line sm:block" />
            <Brand size="sm" />
          </div>
          <CopyButton
            text={hpi}
            label="Copy HPI"
            onCopied={() => report("clinician_hpi_copied", data.id)}
          />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {data.urgentFlag && (
          <div role="alert" className="mb-6 rounded-lg border border-alert/30 bg-alert-soft px-4 py-3">
            <p className="text-[15px] text-alert">
              <strong className="font-semibold">Flagged during intake.</strong> The patient
              used language the intake screens for as potentially urgent. Review before the
              visit; the patient was shown emergency guidance and told nobody is monitoring
              intake in real time.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="font-serif text-3xl tracking-[-0.02em] text-ink">{data.patientName}</h1>
          <p className="text-[14px] text-muted">
            {data.age !== null && `${data.age}y · `}DOB {data.dateOfBirth} · {when} · booked as
            &ldquo;{data.reasonBooked}&rdquo;
          </p>
        </div>

        <p className="mt-5 max-w-3xl border-l-2 border-accent pl-5 font-serif text-[1.6rem] leading-[1.3] tracking-[-0.01em] text-ink">
          {data.headline}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <span>{data.pathwayLabel} pathway</span>
          <span>· {data.questionCount} questions</span>
          <span>· {data.durationLabel}</span>
          <button
            type="button"
            onClick={() => setShowWords((s) => !s)}
            className="-my-1 rounded px-1 py-2 text-accent underline underline-offset-2 no-print"
          >
            {showWords ? "Hide patient's own words" : "Show patient's own words"}
          </button>
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-12">
          {/* -------------------------------------------------- brief column */}
          <section className="lg:col-span-7">
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="border-b hairline bg-paper px-5 py-2.5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Pre-visit brief · patient-supplied
                </h2>
              </div>
              <dl className="divide-y divide-[var(--color-line)]">
                {data.sections.map((s) => (
                  <div key={s.label} className="grid gap-1 px-5 py-3.5 sm:grid-cols-[10.5rem_1fr] sm:gap-4">
                    <dt className="pt-0.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">
                      {s.label}
                    </dt>
                    <dd className="space-y-2">
                      {s.items.map((i) => (
                        <div key={i.slot}>
                          <p className="text-[15px] leading-relaxed text-ink">
                            {i.text}
                            {i.certainty !== "stated" && (
                              <span className="ml-2 rounded bg-flag-soft px-1.5 py-0.5 align-middle text-[11px] text-flag">
                                {i.certainty === "approximate" ? "approx." : "unsure"}
                              </span>
                            )}
                          </p>
                          {showWords && (
                            <p className="mt-1 border-l-2 border-line pl-3 text-[13px] italic leading-relaxed text-muted">
                              &ldquo;{i.verbatim}&rdquo;
                            </p>
                          )}
                        </div>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {data.photos.length > 0 && (
              <div className="mt-6 overflow-hidden rounded-xl border border-line bg-surface">
                <div className="border-b hairline bg-paper px-5 py-2.5">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                    Reference photos · patient-supplied
                  </h2>
                </div>
                <div className="grid grid-cols-3 gap-3 p-4">
                  {data.photos.map((p) => (
                    <figure key={p.id}>
                      <Image
                        src={p.dataUrl}
                        alt={p.caption || "Patient-supplied reference photo"}
                        width={400}
                        height={400}
                        unoptimized
                        className="aspect-square w-full rounded-lg border border-line object-cover"
                      />
                      {p.caption && (
                        <figcaption className="mt-1.5 text-[12px] text-muted">{p.caption}</figcaption>
                      )}
                    </figure>
                  ))}
                </div>
                <p className="border-t hairline px-5 py-2.5 text-[12px] text-muted">
                  Reference material only. No image analysis is performed.
                </p>
              </div>
            )}
          </section>

          {/* ------------------------------------------------- actions column */}
          <section className="space-y-6 lg:col-span-5">
            {(data.openQuestions.length > 0 || data.patientQuestions.length > 0) && (
              <div className="overflow-hidden rounded-xl border border-flag/30 bg-flag-soft">
                <div className="border-b border-flag/20 px-5 py-2.5">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-flag">
                    Clarify in visit
                  </h2>
                </div>
                <ul className="space-y-2 px-5 py-4">
                  {data.patientQuestions.map((q) => (
                    <li key={q} className="text-[14px] leading-relaxed text-ink">
                      <span className="font-medium">Patient asked:</span> &ldquo;{q}&rdquo;
                    </li>
                  ))}
                  {data.openQuestions.map((q) => (
                    <li key={q} className="text-[14px] leading-relaxed text-ink-soft">
                      {q}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center justify-between gap-3 border-b hairline bg-paper px-5 py-2.5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Draft HPI · editable
                </h2>
                <span className="text-[11px] text-muted">
                  {data.hpiSource === "model" ? "AI-organised, patient-sourced" : "Assembled from answers"}
                </span>
              </div>
              <textarea
                ref={hpiRef}
                value={hpi}
                onChange={(e) => setHpi(e.target.value)}
                onBlur={() => patch({ hpi }, "hpi")}
                rows={10}
                aria-label="Draft history of present illness"
                className="w-full resize-y overflow-hidden bg-surface px-5 py-4 font-mono text-[13.5px] leading-relaxed text-ink focus:bg-paper"
              />
              <div className="flex items-center justify-between gap-3 border-t hairline px-5 py-3">
                <p className="text-[12px] text-muted">
                  {saving === "hpi" ? "Saving…" : saved === "hpi" ? "Saved" : "Edits save automatically"}
                </p>
                <CopyButton
                  text={hpi}
                  label="Copy HPI"
                  onCopied={() => report("clinician_hpi_copied", data.id)}
                />
              </div>
              <p className="border-t hairline px-5 py-2.5 text-[12px] leading-relaxed text-muted">
                Built only from what the patient said. Nothing is added — no examination
                findings, no negatives they did not state, no assessment.
              </p>
            </div>

          </section>
        </div>

        {/* The encounter scratchpad gets the full width: it is used after the
            visit, when the brief above has already done its job. */}
        <div className="mt-8 grid gap-8 lg:grid-cols-12">
          <section className="lg:col-span-5">
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="border-b hairline bg-paper px-5 py-2.5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                  After the visit · your findings
                </h2>
              </div>
              <div className="space-y-4 px-5 py-4">
                {(
                  [
                    ["exam", "Key exam observations", 3],
                    ["assessment", "Diagnosis / impression", 2],
                    ["plan", "Plan", 3],
                    ["medications", "Medications discussed", 2],
                    ["followUp", "Follow-up", 2],
                  ] as const
                ).map(([key, label, rows]) => (
                  <div key={key}>
                    <label
                      htmlFor={`f-${key}`}
                      className="text-[12px] font-medium uppercase tracking-[0.06em] text-muted"
                    >
                      {label}
                    </label>
                    <textarea
                      id={`f-${key}`}
                      rows={rows}
                      value={review[key]}
                      onChange={(e) => setReview((r) => ({ ...r, [key]: e.target.value }))}
                      onBlur={() => patch({ review }, "review")}
                      className="mt-1.5 w-full resize-y rounded-lg border border-line bg-paper px-3 py-2 text-[14px] leading-relaxed text-ink focus:border-accent focus:bg-surface"
                    />
                  </div>
                ))}
                <p className="text-[12px] leading-relaxed text-muted">
                  A scratchpad for the note, not a chart. Medications entered here are never
                  transmitted to a pharmacy — AION Intake does not prescribe.
                </p>
                <button
                  type="button"
                  onClick={generateNote}
                  disabled={saving === "note"}
                  className="w-full rounded-lg bg-accent px-4 py-2.5 text-[15px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
                >
                  {saving === "note" ? "Generating…" : "Generate draft note"}
                </button>
              </div>
            </div>

          </section>

          <section className="lg:col-span-7">
            {note ? (
              <div className="overflow-hidden rounded-xl border border-line bg-surface">
                <div className="flex items-center justify-between gap-3 border-b hairline bg-paper px-5 py-2.5">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
                    Draft note
                  </h2>
                  <CopyButton
                    text={note}
                    label="Copy note"
                    variant="quiet"
                    onCopied={() => report("clinician_note_copied", data.id)}
                  />
                </div>
                <textarea
                  ref={noteRef}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={18}
                  aria-label="Draft clinical note"
                  className="w-full resize-y overflow-hidden bg-surface px-5 py-4 font-mono text-[13px] leading-relaxed text-ink focus:bg-paper"
                />
              </div>
            ) : (
              <div className="flex h-full min-h-[12rem] items-center justify-center rounded-xl border border-dashed border-line-strong px-8 py-10 text-center">
                <p className="max-w-sm text-[14px] leading-relaxed text-muted">
                  Add your findings and the draft note appears here — the patient&rsquo;s
                  history and your assessment kept in separate, labelled blocks, ready to
                  paste into your record.
                </p>
              </div>
            )}
          </section>
        </div>

        <p className="mt-8 border-t hairline pt-4 text-[12px] leading-relaxed text-muted">
          {data.aiCostUsd > 0
            ? `Intake AI cost for this patient: $${data.aiCostUsd.toFixed(4)}`
            : "This intake was produced by the deterministic interview engine — no AI cost."}
        </p>
      </main>
    </div>
  );
}
