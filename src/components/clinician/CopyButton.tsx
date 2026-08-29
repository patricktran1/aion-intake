"use client";

import { useState } from "react";

/** Copy is the highest-value action on this screen; it must never silently fail. */
export function CopyButton({
  text,
  label,
  onCopied,
  variant = "primary",
}: {
  text: string;
  label: string;
  onCopied?: () => void;
  variant?: "primary" | "quiet";
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setState("copied");
      onCopied?.();
      setTimeout(() => setState("idle"), 2000);
    } catch {
      setState("failed");
      setTimeout(() => setState("idle"), 3000);
    }
  }

  const base =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accent-hover"
      : "border border-line-strong text-ink hover:border-accent hover:text-accent";

  return (
    <button
      type="button"
      onClick={copy}
      className={`rounded-lg px-3.5 py-2 text-[14px] font-medium transition ${base}`}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Select and copy manually" : label}
    </button>
  );
}
