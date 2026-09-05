"use client";

import { useState } from "react";
import { Brand } from "@/components/Brand";
import type { SecondFactorChallenge } from "@/lib/patient/second-factor";

/**
 * One question, one field, one button.
 *
 * The screen is rendered from whatever challenge the configured second factor
 * supplies, so adding a strategy never adds a control here. It knows nothing
 * about dates of birth or codes — a patient-facing security screen that offers
 * choices is a screen people fail.
 *
 * It is handed nothing about the patient. Name, date of birth and answers stay
 * on the server until the factor is passed; otherwise the factor would be
 * guarding writes while the record was already on screen.
 */
export function VerifyGate({ token, challenge }: { token: string; challenge: SecondFactorChallenge }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intake/${token}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: value }),
      });
      if (res.ok) {
        // A full reload rather than client-side state: the server decides what
        // this token may now see, and it should decide it from scratch.
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "That did not match. Please check and try again.");
      setValue("");
    } catch {
      setError("We couldn't reach the clinic. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh-safe">
      <header className="border-b hairline bg-surface">
        <div className="mx-auto flex max-w-xl items-center px-6 py-4">
          <Brand size="sm" />
        </div>
      </header>

      <section className="mx-auto max-w-xl px-6 py-16">
        <h1 className="font-serif text-2xl tracking-[-0.02em] text-ink">Before we start</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{challenge.hint}</p>

        <form onSubmit={submit} className="mt-8">
          <label htmlFor="second-factor" className="block text-[14px] font-medium text-ink">
            {challenge.label}
          </label>
          <input
            id="second-factor"
            name="second-factor"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            inputMode={challenge.inputMode}
            maxLength={challenge.maxLength}
            autoComplete="off"
            autoFocus
            aria-invalid={error !== null}
            aria-describedby={error ? "second-factor-error" : undefined}
            className="mt-2 w-full rounded-lg border border-line-strong bg-surface px-4 py-3 text-[16px] text-ink outline-none focus:border-accent"
          />
          {error && (
            <p id="second-factor-error" role="alert" className="mt-3 text-[14px] text-flag">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || value.trim().length === 0}
            className="mt-6 w-full rounded-lg bg-ink px-4 py-3 text-[15px] font-medium text-paper transition disabled:opacity-40"
          >
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>

        <p className="mt-8 text-[13px] leading-relaxed text-muted">
          If this doesn&apos;t work, call the clinic — they can send you a new link. Don&apos;t forward
          this one.
        </p>
      </section>
    </main>
  );
}
