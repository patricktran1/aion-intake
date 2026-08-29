"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/clinician/CopyButton";

/**
 * The two things a person running a demo actually does: put the data back to a
 * known state, and get to the intake link. Everything else on the demo page is
 * reading material.
 */
export function DemoControls({ intakeHref, answers }: { intakeHref: string; answers: string[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const router = useRouter();

  async function reset(then?: () => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/reset", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
      then?.();
    } catch {
      setError("Reset did not go through. Try once more.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-7 rounded-xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => reset(() => router.push(intakeHref))}
          className="rounded-lg bg-accent px-5 py-3 text-[15px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
        >
          {busy ? "Resetting…" : "Reset and start the intake"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => reset()}
          className="rounded-lg border border-line-strong px-5 py-3 text-[15px] text-ink transition hover:border-ink-soft disabled:opacity-60"
        >
          Reset only
        </button>
        <CopyButton
          text={`${typeof window !== "undefined" ? window.location.origin : ""}${intakeHref}`}
          label="Copy intake link"
          variant="quiet"
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-[14px] text-flag">
          {error}
        </p>
      )}

      <div className="mt-6 border-t hairline pt-5">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            The answers to read aloud
          </h2>
          <div className="flex items-center gap-2">
            <CopyButton text={answers.join("\n\n")} label="Copy all" variant="quiet" />
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="rounded px-2 py-2 text-[13px] text-accent underline underline-offset-2"
            >
              {open ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {open && (
          <ol className="mt-4 space-y-2.5">
            {answers.map((a, i) => (
              <li key={a} className="flex gap-3 text-[15px] leading-relaxed text-ink-soft">
                <span className="mt-px w-5 shrink-0 text-right font-mono text-[12px] text-muted">
                  {i + 1}
                </span>
                <span>{a}</span>
              </li>
            ))}
          </ol>
        )}
        {!open && (
          <p className="mt-3 text-[13px] text-muted">
            Eight answers, in order. The interview will not ask all eight — that is the point
            to make out loud when it skips one.
          </p>
        )}
      </div>
    </div>
  );
}
