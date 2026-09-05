"use client";

import { useState } from "react";
import { Brand } from "@/components/Brand";

/**
 * One form, one error message.
 *
 * The message is the same whatever went wrong — unknown address, wrong
 * password, disabled account — because the server already refuses to
 * distinguish them, and a helpful client-side message would give back exactly
 * what the server took care not to say.
 */
export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // A full document load rather than a client-side push. The session
        // cookie has just been set and the worklist is a server component that
        // reads it; a soft navigation would render against the router's cache
        // and the guard would see the request without it.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/clinician";
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Sign-in failed. Please try again.");
      setPassword("");
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-dvh-safe">
      <header className="border-b hairline bg-surface">
        <div className="mx-auto flex max-w-md items-center px-6 py-4">
          <Brand size="sm" />
        </div>
      </header>

      <section className="mx-auto max-w-md px-6 py-16">
        <h1 className="font-serif text-2xl tracking-[-0.02em] text-ink">Sign in</h1>

        <form onSubmit={submit} className="mt-8 space-y-5">
          <div>
            <label htmlFor="email" className="block text-[14px] font-medium text-ink">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              className="mt-2 w-full rounded-lg border border-line-strong bg-surface px-4 py-3 text-[16px] text-ink outline-none focus:border-accent"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-[14px] font-medium text-ink">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="mt-2 w-full rounded-lg border border-line-strong bg-surface px-4 py-3 text-[16px] text-ink outline-none focus:border-accent"
            />
          </div>
          {error && (
            <p role="alert" className="text-[14px] text-flag">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-ink px-4 py-3 text-[15px] font-medium text-paper transition disabled:opacity-40"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
