import Link from "next/link";
import { Brand } from "@/components/Brand";
import { CONFERENCE_CASE } from "@/lib/demo/seed";
import { listBundles } from "@/lib/store";
import { isModelEnabled, modelName } from "@/lib/ai/client";
import { DemoControls } from "@/components/demo/DemoControls";
import { PATHWAY_LABELS } from "@/lib/domain/types";

export const dynamic = "force-dynamic";

/**
 * The founder's control panel.
 *
 * Deliberately a third surface, not a widget bolted into the patient or
 * clinician screens. Those two have to stay exactly what a patient and a
 * dermatologist would see; everything a person running a demo needs lives here
 * instead. See DEMO.md for the scripts.
 */
export default function DemoPage() {
  const bundles = listBundles();
  const conference = bundles.find((b) => b.intake.token === CONFERENCE_CASE.token);
  const completed = bundles.filter(
    (b) => b.intake.status === "ready_for_review" || b.intake.status === "reviewed",
  );

  return (
    <main className="min-h-dvh-safe">
      <header className="border-b hairline bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <div className="flex items-baseline gap-4">
            <Link href="/">
              <Brand size="sm" />
            </Link>
            <span className="text-sm text-muted">Demo controls</span>
          </div>
          <span className="text-xs text-muted">Synthetic data only</span>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-serif text-3xl tracking-[-0.02em] text-ink">Run the demo</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-ink-soft">
          One page for whoever is holding the phone. Reset, hand it over, read the answers,
          then open the brief. Nothing on this page is visible from the patient or clinician
          screens.
        </p>

        <DemoControls
          intakeHref={`/intake/${CONFERENCE_CASE.token}`}
          answers={[...CONFERENCE_CASE.answers]}
        />

        <section className="mt-10 grid gap-6 sm:grid-cols-2">
          <div className="rounded-xl border border-line bg-surface p-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
              Two minutes
            </h2>
            <ol className="mt-4 space-y-3 text-[15px] leading-relaxed text-ink-soft">
              <li>
                <span className="font-medium text-ink">1.</span> Open the clinician view and
                pick <span className="font-medium text-ink">Robert Osei</span>. Say nothing.
              </li>
              <li>
                <span className="font-medium text-ink">2.</span> Let them read. Most
                dermatologists get the case in fifteen seconds.
              </li>
              <li>
                <span className="font-medium text-ink">3.</span> Tap{" "}
                <span className="font-medium text-ink">Show patient&rsquo;s own words</span>.
                That is the trust argument, made in one click.
              </li>
              <li>
                <span className="font-medium text-ink">4.</span> Point at{" "}
                <span className="font-medium text-ink">Clarify in visit</span>: the change was
                reported by his wife, not seen by him.
              </li>
            </ol>
            <Link
              href="/clinician"
              className="mt-5 inline-block rounded-lg bg-accent px-4 py-2.5 text-[15px] font-medium text-white transition hover:bg-accent-hover"
            >
              Open the clinician view
            </Link>
          </div>

          <div className="rounded-xl border border-line bg-surface p-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
              Five minutes
            </h2>
            <ol className="mt-4 space-y-3 text-[15px] leading-relaxed text-ink-soft">
              <li>
                <span className="font-medium text-ink">1.</span> Reset, then hand them the
                phone on the intake link above.
              </li>
              <li>
                <span className="font-medium text-ink">2.</span> Read the answers aloud while
                they type. Watch the questions change after the first one.
              </li>
              <li>
                <span className="font-medium text-ink">3.</span> Add a photo, correct one line
                on the review screen, submit.
              </li>
              <li>
                <span className="font-medium text-ink">4.</span> Open the brief you just
                created. Ask how long that history takes them in the room.
              </li>
            </ol>
            {conference && conference.intake.status !== "not_started" ? (
              <Link
                href={`/clinician/${conference.intake.id}`}
                className="mt-5 inline-block rounded-lg bg-accent px-4 py-2.5 text-[15px] font-medium text-white transition hover:bg-accent-hover"
              >
                Open the brief you just created
              </Link>
            ) : (
              <p className="mt-5 text-[13px] text-muted">
                The brief link appears here once the intake is submitted.
              </p>
            )}
          </div>
        </section>

        <section className="mt-10 rounded-xl border border-line bg-surface p-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            What to point at
          </h2>
          <ul className="mt-4 space-y-2">
            {CONFERENCE_CASE.talkingPoints.map((t) => (
              <li key={t} className="flex gap-3 text-[15px] leading-relaxed text-ink-soft">
                <span aria-hidden className="mt-[10px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                {t}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-10 rounded-xl border border-line bg-surface p-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Current state
          </h2>
          <table className="mt-4 w-full text-left text-[14px]">
            <tbody className="divide-y divide-[var(--color-line)]">
              {bundles.map((b) => (
                <tr key={b.intake.id}>
                  <td className="py-2.5 pr-4 font-medium text-ink">
                    {b.patient.firstName} {b.patient.lastName}
                  </td>
                  <td className="py-2.5 pr-4 text-muted">{PATHWAY_LABELS[b.intake.pathway]}</td>
                  <td className="py-2.5 pr-4 text-muted">
                    {b.intake.status === "not_started"
                      ? "not started"
                      : b.intake.status === "in_progress"
                        ? `${b.intake.questionCount} answered`
                        : `${b.intake.questionCount} questions`}
                  </td>
                  <td className="py-2.5 text-right">
                    {b.intake.status === "not_started" ? (
                      <Link href={`/intake/${b.intake.token}`} className="text-accent underline underline-offset-2">
                        intake link
                      </Link>
                    ) : (
                      <Link href={`/clinician/${b.intake.id}`} className="text-accent underline underline-offset-2">
                        brief
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-[13px] leading-relaxed text-muted">
            {completed.length} completed {completed.length === 1 ? "intake" : "intakes"} · AI mode{" "}
            <strong className="font-medium text-ink-soft">
              {isModelEnabled() ? `model (${modelName()})` : "deterministic, zero cost"}
            </strong>
            . Open intake links are stable across resets, so a printed QR code keeps working.
          </p>
        </section>

        <p className="mt-8 text-[13px] leading-relaxed text-muted">
          If a demo goes wrong: reset, reload, and start again. Everything lives in memory,
          so a restart is a clean slate. The two open intake links never change.
        </p>
      </div>
    </main>
  );
}
