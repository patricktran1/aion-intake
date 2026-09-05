"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { MAX_PHOTOS, PHOTO_TIPS } from "@/lib/photos";
import { prepareImage } from "./imagePrep";
import type { PatientView } from "@/lib/api";

/**
 * Up to three reference photographs.
 *
 * The copy is careful here: these are pictures the dermatologist will look at
 * during the visit. Nothing analyses them, and the patient is told so plainly
 * rather than left to assume otherwise.
 */
export function PhotoStep({
  token,
  photos,
  clinicianName,
  onUpdate,
  onContinue,
}: {
  token: string;
  photos: PatientView["photos"];
  clinicianName: string;
  onUpdate: (view: PatientView) => void;
  onContinue: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const full = photos.length >= MAX_PHOTOS;

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, MAX_PHOTOS - photos.length)) {
        const prepared = await prepareImage(file);
        // One key per selected file, minted before the request goes out. The
        // server has always accepted this and had a unique index behind it, and
        // the client never sent one — so "a retried upload cannot create a
        // second photo" was true of the API and unreachable from the app. A
        // patient on hospital wifi whose upload times out and retries is
        // exactly who that guarantee is for.
        const idempotencyKey =
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const res = await fetch(`/api/intake/${token}/photos`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dataUrl: prepared.dataUrl,
            width: prepared.width,
            height: prepared.height,
            mime: prepared.mime,
            sharpness: prepared.sharpness,
            kind: photos.length === 0 ? "wide" : "close",
            idempotencyKey,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "That photo couldn't be added.");
          break;
        }
        onUpdate(data as PatientView);
      }
    } catch {
      setError("That photo couldn't be read on this device. You can skip photos entirely.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/intake/${token}/photos/${id}`, { method: "DELETE" });
    if (res.ok) onUpdate((await res.json()) as PatientView);
  }

  const advisories = photos.flatMap((p) => p.advisories);

  return (
    <div className="mx-auto w-full max-w-xl px-5 py-8">
      <h2 className="font-serif text-[1.7rem] leading-tight tracking-[-0.01em] text-ink">
        Want to add a photo or two?
      </h2>
      <p className="mt-3 text-[16px] leading-relaxed text-ink-soft">
        Entirely up to you. If you add photos, {clinicianName} will have them open while you
        talk — useful when skin looks different on the day than it does right now.
      </p>

      <ul className="mt-5 space-y-1.5">
        {PHOTO_TIPS.map((t) => (
          <li key={t} className="flex gap-2.5 text-[15px] leading-relaxed text-ink-soft">
            <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-line-strong" />
            {t}
          </li>
        ))}
      </ul>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {photos.map((p) => (
          <figure key={p.id} className="relative overflow-hidden rounded-xl border border-line bg-surface">
            <Image
              src={p.dataUrl}
              alt={p.caption || "Photo you added"}
              width={300}
              height={300}
              unoptimized
              className="aspect-square w-full object-cover"
            />
            <button
              type="button"
              onClick={() => remove(p.id)}
              aria-label="Remove this photo"
              className="group absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-white"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink/75 transition group-hover:bg-ink">
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </span>
            </button>
          </figure>
        ))}

        {!full && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-surface text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7l1.1-1.7A1 1 0 0 1 9.1 4h5.8a1 1 0 0 1 .8.3L16.8 6h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
              <circle cx="12" cy="12" r="3.2" />
            </svg>
            <span className="text-xs">{busy ? "Adding…" : "Add photo"}</span>
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        aria-label="Choose a photo to add"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-flag/30 bg-flag-soft px-3.5 py-2.5 text-[14px] text-flag">
          {error}
        </p>
      )}
      {advisories.length > 0 && (
        <p className="mt-4 rounded-lg border border-line bg-paper px-3.5 py-2.5 text-[14px] leading-relaxed text-ink-soft">
          {advisories[0]} <span className="text-muted">You can keep it either way.</span>
        </p>
      )}

      <p className="mt-5 text-[13px] leading-relaxed text-muted">
        These are just for {clinicianName} to look at with you. Nothing analyses them.
      </p>

      <button
        type="button"
        onClick={onContinue}
        className="mt-7 w-full rounded-xl bg-accent px-6 py-4 text-[17px] font-medium text-white transition hover:bg-accent-hover"
      >
        {photos.length > 0 ? "Continue" : "Skip photos"}
      </button>
    </div>
  );
}
