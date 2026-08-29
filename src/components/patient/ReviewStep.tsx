"use client";

import { useState } from "react";
import Image from "next/image";
import type { PatientView } from "@/lib/api";

/**
 * "You told us…"
 *
 * Every line is editable in place. The patient's correction replaces both the
 * summary and the quoted words behind it, so the physician never reads back a
 * sentence the patient already disagreed with.
 */
export function ReviewStep({
  token,
  view,
  onUpdate,
  onSubmit,
  submitting,
}: {
  token: string;
  view: PatientView;
  onUpdate: (v: PatientView) => void;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function save(slot: string) {
    setSaving(true);
    const res = await fetch(`/api/intake/${token}/facts`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, value: draft }),
    });
    if (res.ok) onUpdate((await res.json()) as PatientView);
    setSaving(false);
    setEditing(null);
  }

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-8">
      <h2 className="font-serif text-[1.7rem] leading-tight tracking-[-0.01em] text-ink">
        Here&rsquo;s what you told us
      </h2>
      <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
        Have a quick read. Tap anything that isn&rsquo;t quite right and fix it — this is
        what {view.practice.clinicianName} will see.
      </p>

      <div className="mt-6 divide-y divide-[var(--color-line)] overflow-hidden rounded-xl border border-line bg-surface">
        {view.summary.map((section) =>
          section.items.map((item) => (
            <div key={`${section.label}-${item.slot}`} className="px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
                  {section.label}
                </h3>
                {editing !== item.slot && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(item.slot);
                      setDraft(item.text);
                    }}
                    className="-my-2 -mr-2 shrink-0 px-3 py-2.5 text-[13px] text-accent underline underline-offset-2"
                  >
                    Edit
                  </button>
                )}
              </div>

              {editing === item.slot ? (
                <div className="mt-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    autoFocus
                    aria-label={`Edit ${section.label}`}
                    className="w-full rounded-lg border border-line-strong bg-paper px-3 py-2.5 text-[16px] leading-relaxed text-ink outline-none focus:border-accent"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => save(item.slot)}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-lg border border-line px-4 py-2 text-sm text-ink-soft"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="mt-1.5 text-[16px] leading-relaxed text-ink">
                  {item.text}
                  {item.certainty !== "stated" && (
                    <span className="ml-2 align-middle text-[12px] text-muted">
                      {item.certainty === "approximate" ? "roughly" : "not sure"}
                    </span>
                  )}
                </p>
              )}
            </div>
          )),
        )}

        {view.photos.length > 0 && (
          <div className="px-4 py-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
              Photos attached
            </h3>
            <div className="mt-2.5 flex gap-2">
              {view.photos.map((p) => (
                <Image
                  key={p.id}
                  src={p.dataUrl}
                  alt=""
                  width={120}
                  height={120}
                  unoptimized
                  className="h-16 w-16 rounded-lg border border-line object-cover"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting}
        className="mt-7 w-full rounded-xl bg-accent px-6 py-4 text-[17px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send this to my dermatologist"}
      </button>
      <p className="mt-3 text-center text-[13px] text-muted">
        Your answers and photos will be reviewed in the context of your upcoming visit.
      </p>
    </div>
  );
}
