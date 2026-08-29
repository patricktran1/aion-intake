import Link from "next/link";
import { Brand } from "@/components/Brand";
import { DEMO_TOKENS } from "@/lib/demo/seed";
import { listBundles } from "@/lib/store";
import { isModelEnabled, modelName } from "@/lib/ai/client";
import { ResetButton } from "@/components/ResetButton";

export const dynamic = "force-dynamic";

export default function Home() {
  const bundles = listBundles();
  const ready = bundles.filter((b) => b.intake.status === "ready_for_review").length;
  const model = isModelEnabled();

  return (
    <main className="min-h-dvh-safe">
      <header className="border-b hairline">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <Brand />
          <span className="text-xs text-muted">Synthetic demo</span>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 pt-16 pb-12 sm:pt-24">
        <p className="text-xs uppercase tracking-[0.2em] text-accent">
          Pre-visit intelligence for dermatology
        </p>
        <h1 className="mt-5 max-w-2xl font-serif text-[2.6rem] leading-[1.1] tracking-[-0.02em] text-ink sm:text-6xl">
          Walk into the room already knowing the story.
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-soft">
          AION Intake holds a short, adaptive conversation with a dermatology patient before
          their appointment, and hands the dermatologist a brief they can read in thirty
          seconds.
        </p>

        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link
            href={`/intake/${DEMO_TOKENS.acne}`}
            className="inline-flex items-center justify-center rounded-lg bg-accent px-6 py-3.5 text-base font-medium text-white transition hover:bg-accent-hover"
          >
            Try the patient intake
          </Link>
          <Link
            href="/clinician"
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface px-6 py-3.5 text-base font-medium text-ink transition hover:border-ink-soft"
          >
            Open the clinician view
            {ready > 0 && (
              <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
                {ready} waiting
              </span>
            )}
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-20">
        <div className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {[
            {
              n: "01",
              h: "The patient talks",
              p: "Plain language or voice. One answer decides the next question, so nobody answers thirty questions to get to the three that matter.",
            },
            {
              n: "02",
              h: "The story gets structured",
              p: "Timeline, symptoms, what they have already tried, and what they actually want out of the visit — with their own words kept alongside.",
            },
            {
              n: "03",
              h: "The dermatologist reads it",
              p: "A one-screen brief, an editable draft HPI, reference photos, and a short list of what is still worth asking in the room.",
            },
          ].map((c) => (
            <div key={c.n} className="bg-surface p-7">
              <span className="font-mono text-xs text-muted">{c.n}</span>
              <h2 className="mt-3 text-base font-semibold text-ink">{c.h}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{c.p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24">
        <div className="rounded-xl border border-line bg-surface p-7">
          <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-muted">
            Demo controls
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
            Everything in this build is synthetic. There is no real patient information in
            it. Three demo patients have already completed intake; two open links let you
            walk the patient side yourself. If you are running this for someone, start from
            the demo controls.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              href={`/intake/${DEMO_TOKENS.acne}`}
              className="rounded-md border border-line px-3.5 py-2 text-sm text-ink transition hover:border-ink-soft"
            >
              Open intake — Daniel W. (acne visit)
            </Link>
            <Link
              href={`/intake/${DEMO_TOKENS.open}`}
              className="rounded-md border border-line px-3.5 py-2 text-sm text-ink transition hover:border-ink-soft"
            >
              Open intake — Lena O. (unspecified)
            </Link>
            <Link
              href="/demo"
              className="rounded-md border border-line px-3.5 py-2 text-sm text-ink transition hover:border-ink-soft"
            >
              Demo controls and script
            </Link>
            <ResetButton />
          </div>
          <p className="mt-5 text-xs leading-relaxed text-muted">
            AI mode: <strong className="font-medium text-ink-soft">{model ? `model (${modelName()})` : "deterministic"}</strong>
            {" — "}
            {model
              ? "language understanding and drafting run through one small model; the interview logic stays deterministic."
              : "no API key configured, so the interview, brief, and draft HPI are produced by the deterministic engine at zero AI cost."}
          </p>
        </div>
      </section>

      <footer className="border-t hairline">
        <div className="mx-auto max-w-5xl px-6 py-8 text-xs leading-relaxed text-muted">
          AION Intake prepares information for an upcoming in-person visit. It does not
          provide medical advice, diagnosis, or treatment, and it is not a substitute for
          speaking with a clinician.
        </div>
      </footer>
    </main>
  );
}
