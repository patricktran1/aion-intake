"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Browser-native speech recognition.
 *
 * Voice is an input method, not a separate product. It fills the same textarea
 * the patient could have typed into, they can edit the transcript before
 * sending, and everything works identically without it. Where the API is
 * missing (Firefox, older browsers, no permission) the microphone simply does
 * not appear.
 */

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type Ctor = new () => SpeechRecognitionLike;

/** Support never changes within a page load, so there is nothing to subscribe to. */
const subscribeNever = () => () => {};

function getCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface SpeechState {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
}

export function useSpeech(onTranscript: (text: string, isFinal: boolean) => void): SpeechState {
  // Read through useSyncExternalStore so the server render (unsupported) and
  // the client render agree, without a hydration-time state update.
  const supported = useSyncExternalStore(subscribeNever, () => getCtor() !== null, () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<SpeechRecognitionLike | null>(null);
  const cb = useRef(onTranscript);

  useEffect(() => {
    cb.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => () => ref.current?.abort(), []);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    setError(null);
    try {
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
      rec.onresult = (e) => {
        let interim = "";
        let final = "";
        for (let i = e.resultIndex; i < e.results.length; i += 1) {
          const r = e.results[i];
          const text = r[0]?.transcript ?? "";
          if (r.isFinal) final += text;
          else interim += text;
        }
        if (final) cb.current(final, true);
        else if (interim) cb.current(interim, false);
      };
      rec.onerror = (e) => {
        setError(
          e.error === "not-allowed"
            ? "Microphone access is off. You can type your answer instead."
            : "Voice didn't work that time. You can type your answer instead.",
        );
        setListening(false);
      };
      rec.onend = () => setListening(false);
      ref.current = rec;
      rec.start();
      setListening(true);
    } catch {
      setError("Voice isn't available on this browser. Typing works just as well.");
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => {
    ref.current?.stop();
    setListening(false);
  }, []);

  return { supported, listening, error, start, stop };
}
