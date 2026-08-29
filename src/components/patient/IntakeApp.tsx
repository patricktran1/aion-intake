"use client";

import { useEffect, useRef, useState } from "react";
import { Brand } from "@/components/Brand";
import type { PatientView } from "@/lib/api";
import { MAX_QUESTIONS } from "@/lib/interview/slots";
import { Composer } from "./Composer";
import { PhotoStep } from "./PhotoStep";
import { ReviewStep } from "./ReviewStep";

type Stage = "welcome" | "chat" | "photos" | "review" | "done";

/**
 * The whole patient experience.
 *
 * Design rules it follows: one thing on screen at a time, text always available,
 * never a dead end, and progress shown as reassurance rather than as a countdown
 * of how much is left to endure.
 */
export function IntakeApp({ initial }: { initial: PatientView }) {
  const [view, setView] = useState(initial);
  const [stage, setStage] = useState<Stage>(() =>
    initial.status === "ready_for_review" || initial.status === "reviewed"
      ? "done"
      : initial.messages.length > 0
        ? "chat"
        : "welcome",
  );
  const [thinking, setThinking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (stage === "chat") endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [view.messages.length, thinking, stage]);

  async function start() {
    setThinking(true);
    setNetError(null);
    try {
      const res = await fetch(`/api/intake/${view.token}/start`, { method: "POST" });
      if (!res.ok) throw new Error();
      setView((await res.json()) as PatientView);
      setStage("chat");
    } catch {
      setNetError("We couldn't start just now. Check your connection and try again.");
    } finally {
      setThinking(false);
    }
  }

  async function send(text: string, mode: "text" | "voice") {
    setThinking(true);
    setNetError(null);
    // Optimistic echo so the conversation never feels laggy on a phone.
    if (text) {
      setView((v) => ({
        ...v,
        messages: [...v.messages, { id: `local_${Date.now()}`, role: "patient", text, inputMode: mode }],
      }));
    }
    try {
      const res = await fetch(`/api/intake/${view.token}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: text, inputMode: mode }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as PatientView & { finished?: boolean };
      setView(data);
      if (data.finished) setStage("photos");
    } catch {
      setNetError("That didn't send. Your answers are saved — try once more.");
    } finally {
      setThinking(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    setNetError(null);
    try {
      const res = await fetch(`/api/intake/${view.token}/submit`, { method: "POST" });
      if (!res.ok) throw new Error();
      setView((await res.json()) as PatientView);
      setStage("done");
    } catch {
      setNetError("We couldn't send that. Your answers are saved — try again in a moment.");
    } finally {
      setSubmitting(false);
    }
  }

  const progress = Math.min(1, view.questionCount / MAX_QUESTIONS);

  return (
    <div className="flex min-h-dvh-safe flex-col bg-paper">
      <header className="sticky top-0 z-10 border-b hairline bg-paper/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between px-5 py-3.5">
          <Brand size="sm" />
          {stage === "chat" && (
            <span className="text-[12px] tabular-nums text-muted">
              {view.questionCount} of about {MAX_QUESTIONS}
            </span>
          )}
        </div>
        {stage === "chat" && (
          <div className="h-[2px] w-full bg-line">
            <div
              className="h-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.max(6, progress * 100)}%` }}
            />
          </div>
        )}
      </header>

      {view.urgentFlag && stage !== "done" && <UrgentBanner />}

      <main className="flex flex-1 flex-col">
        {stage === "welcome" && (
          <Welcome view={view} onStart={start} busy={thinking} error={netError} />
        )}

        {stage === "chat" && (
          <>
            {/* Bottom-aligned so the newest question always sits just above the
                composer instead of stranding it at the top of a tall phone. */}
            <div className="flex flex-1 flex-col justify-end">
              <div className="mx-auto w-full max-w-xl px-5 py-6">
                <ol className="space-y-5">
                  {view.messages.map((m) => (
                    <li key={m.id} className="rise">
                      {m.role === "assistant" ? (
                        <p className="max-w-[32ch] text-[1.3rem] font-medium leading-[1.4] tracking-[-0.015em] text-ink sm:max-w-none">
                          {m.text}
                        </p>
                      ) : (
                        <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-4 py-2.5 text-[16px] leading-relaxed text-ink">
                          {m.text || <span className="text-muted">Skipped</span>}
                        </p>
                      )}
                    </li>
                  ))}
                  {thinking && (
                    <li aria-live="polite" className="flex gap-1.5 pt-1">
                      {[0, 1, 2].map((i) => (
                        <span key={i} className="dot h-1.5 w-1.5 rounded-full bg-muted" />
                      ))}
                    </li>
                  )}
                </ol>
                {netError && (
                  <p role="alert" className="mt-5 rounded-lg border border-flag/30 bg-flag-soft px-3.5 py-2.5 text-[14px] text-flag">
                    {netError}
                  </p>
                )}
                <div ref={endRef} className="h-2" />
              </div>
            </div>
            <div className="sticky bottom-0">
              <Composer
                onSend={send}
                disabled={thinking}
                chips={view.chips}
                hint={view.hint}
              />
            </div>
          </>
        )}

        {stage === "photos" && (
          <PhotoStep
            token={view.token}
            photos={view.photos}
            clinicianName={view.practice.clinicianName}
            onUpdate={setView}
            onContinue={() => setStage("review")}
          />
        )}

        {stage === "review" && (
          <>
            <ReviewStep
              token={view.token}
              view={view}
              onUpdate={setView}
              onSubmit={submit}
              submitting={submitting}
            />
            {netError && (
              <p role="alert" className="mx-auto max-w-xl px-5 pb-6 text-[14px] text-flag">
                {netError}
              </p>
            )}
          </>
        )}

        {stage === "done" && <Done view={view} />}
      </main>
    </div>
  );
}

function Welcome({
  view,
  onStart,
  busy,
  error,
}: {
  view: PatientView;
  onStart: () => void;
  busy: boolean;
  error: string | null;
}) {
  const when = new Date(view.visit.scheduledFor).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="mx-auto w-full max-w-xl px-5 pb-10 pt-8">
      <p className="text-[13px] uppercase tracking-[0.14em] text-accent">
        {view.practice.name}
      </p>
      <h1 className="mt-4 font-serif text-[2rem] leading-[1.15] tracking-[-0.02em] text-ink">
        Hi {view.patient.firstName} — let&rsquo;s get {view.practice.clinicianName} up to
        speed before {when}.
      </h1>
      <p className="mt-5 text-[17px] leading-relaxed text-ink-soft">
        A few questions about what brought you in, in your own words. Most people finish in
        three to five minutes. You can type or use your voice, and add a photo if you want
        to.
      </p>

      <div className="mt-7 rounded-xl border border-line bg-surface p-5">
        <p className="text-[15px] leading-relaxed text-ink-soft">
          AION Intake helps prepare information for your upcoming visit. It does not provide
          medical advice, diagnosis, or treatment, and it is not a substitute for your
          appointment. Your responses and photos will be reviewed in the context of that
          visit.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
          Please don&rsquo;t use it for urgent or emergency concerns — for those, call your
          clinic, or dial 911 or your local emergency number.
        </p>
      </div>

      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="mt-7 w-full rounded-xl bg-accent px-6 py-4 text-[17px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-60"
      >
        {busy ? "One moment…" : "Start"}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-center text-[14px] text-flag">
          {error}
        </p>
      )}
      <p className="mt-4 text-center text-[13px] text-muted">
        Takes about 3–5 minutes · You can stop and come back
      </p>
    </div>
  );
}

function UrgentBanner() {
  return (
    <div role="alert" className="border-b border-alert/25 bg-alert-soft">
      <div className="mx-auto w-full max-w-xl px-5 py-3.5">
        <p className="text-[15px] leading-relaxed text-alert">
          <strong className="font-semibold">If this is an emergency, stop here.</strong>{" "}
          Call 911 or your local emergency number, or go to the nearest emergency
          department. AION Intake is only preparing information for a future appointment and
          nobody is reading this in real time.
        </p>
      </div>
    </div>
  );
}

function Done({ view }: { view: PatientView }) {
  const when = new Date(view.visit.scheduledFor).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  return (
    <div className="mx-auto w-full max-w-xl px-5 py-14 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft">
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-accent" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="mt-6 font-serif text-[1.9rem] leading-tight tracking-[-0.01em] text-ink">
        That&rsquo;s everything — thank you.
      </h1>
      <p className="mx-auto mt-4 max-w-md text-[17px] leading-relaxed text-ink-soft">
        {view.practice.clinicianName} will have read this before you sit down on {when}, so
        you can start with the part that matters instead of the paperwork.
      </p>
      <p className="mx-auto mt-6 max-w-md text-[14px] leading-relaxed text-muted">
        If something changes before then, or a new concern comes up, mention it at the visit
        — nobody is monitoring this between now and your appointment.
      </p>
    </div>
  );
}
