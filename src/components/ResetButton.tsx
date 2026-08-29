"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Restores the synthetic demo to its seeded state. */
export function ResetButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/demo/reset", { method: "POST" });
        router.refresh();
        setBusy(false);
      }}
      className="rounded-md border border-line px-3.5 py-2 text-sm text-muted transition hover:border-ink-soft hover:text-ink disabled:opacity-50"
    >
      {busy ? "Resetting…" : "Reset demo data"}
    </button>
  );
}
