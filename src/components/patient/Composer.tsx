"use client";

import { useEffect, useRef, useState } from "react";
import { useSpeech } from "./useSpeech";

/**
 * The one input the patient uses for the whole interview.
 *
 * Text is always available and always primary. Voice appends into the same box
 * so the patient can fix a misheard word before sending — the transcript is
 * never sent behind their back.
 */
export function Composer({
  onSend,
  disabled,
  chips,
  hint,
  placeholder = "Type your answer…",
}: {
  onSend: (text: string, mode: "text" | "voice") => void;
  disabled: boolean;
  chips: string[];
  hint: string | null;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [usedVoice, setUsedVoice] = useState(false);
  const [interim, setInterim] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const speech = useSpeech((text, isFinal) => {
    if (isFinal) {
      setInterim("");
      setUsedVoice(true);
      setValue((v) => (v ? `${v} ${text}`.replace(/\s+/g, " ") : text).trimStart());
    } else {
      setInterim(text);
    }
  });

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [value, interim]);

  const submit = (text: string, mode: "text" | "voice") => {
    const t = text.trim();
    if (!t || disabled) return;
    if (speech.listening) speech.stop();
    setValue("");
    setInterim("");
    setUsedVoice(false);
    onSend(t, mode);
  };

  return (
    <div className="border-t hairline bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <div className="mx-auto w-full max-w-xl px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3">
        {chips.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                disabled={disabled}
                onClick={() => submit(c, "text")}
                className="rounded-full border border-line bg-paper px-3.5 py-1.5 text-sm text-ink-soft transition hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {hint && <p className="mb-2 text-[13px] leading-snug text-muted">{hint}</p>}

        <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-surface p-2 focus-within:border-accent">
          <textarea
            ref={taRef}
            value={interim ? `${value}${value ? " " : ""}${interim}` : value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(value, usedVoice ? "voice" : "text");
              }
            }}
            disabled={disabled}
            rows={1}
            placeholder={speech.listening ? "Listening — speak naturally…" : placeholder}
            aria-label="Your answer"
            className="max-h-[180px] min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-[17px] leading-snug text-ink outline-none placeholder:text-muted disabled:opacity-60"
          />

          {speech.supported && (
            <button
              type="button"
              onClick={() => (speech.listening ? speech.stop() : speech.start())}
              disabled={disabled}
              aria-pressed={speech.listening}
              aria-label={speech.listening ? "Stop recording" : "Answer with your voice"}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition ${
                speech.listening
                  ? "border-accent bg-accent text-white"
                  : "border-line bg-paper text-ink-soft hover:border-accent hover:text-accent"
              } disabled:opacity-40`}
            >
              <MicIcon active={speech.listening} />
            </button>
          )}

          <button
            type="button"
            onClick={() => submit(value, usedVoice ? "voice" : "text")}
            disabled={disabled || value.trim().length === 0}
            aria-label="Send answer"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition hover:bg-accent-hover disabled:bg-line-strong"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M10 16V4M10 4l-5 5M10 4l5 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        <div className="mt-2 flex min-h-[18px] items-center justify-between gap-3">
          <p className="text-[12px] text-muted">
            {speech.error ? (
              <span className="text-flag">{speech.error}</span>
            ) : speech.listening ? (
              "Tap the microphone again when you're done. You can edit before sending."
            ) : (
              ""
            )}
          </p>
          <button
            type="button"
            onClick={() => onSend("", "text")}
            disabled={disabled}
            className="shrink-0 text-[13px] text-muted underline underline-offset-2 transition hover:text-ink disabled:opacity-40"
          >
            Skip this one
          </button>
        </div>
      </div>
    </div>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="7.25" y="2.5" width="5.5" height="9.5" rx="2.75" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" strokeLinecap="round" />
      {active && <circle cx="10" cy="7" r="1.4" fill="currentColor" stroke="none" />}
    </svg>
  );
}
