import Link from "next/link";
import { redirect } from "next/navigation";
import { Brand } from "@/components/Brand";
import { listBundles, store } from "@/lib/store";
import { listRow } from "@/lib/api";
import { PATHWAY_LABELS } from "@/lib/domain/types";
import { isPilot } from "@/lib/config/runtime";
import { requireClinician } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  ready_for_review: "Ready",
  in_progress: "In progress",
  not_started: "Not started",
  reviewed: "Reviewed",
};

/**
 * The clinician's list. Five columns, no chrome, no widgets.
 *
 * This screen exists only to get the dermatologist into the brief. Anything
 * that would make it feel like an EHR homepage has been deliberately left out.
 */
/**
 * A physician scanning this list is asking "who am I seeing next", not "what
 * date is it". Relative days answer that; the date is there for the two or
 * three cases where it matters.
 */
function relativeDay(iso: string): { label: string; soon: boolean } {
  const target = new Date(iso);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(target) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return { label: "Today", soon: true };
  if (days === 1) return { label: "Tomorrow", soon: true };
  if (days > 1 && days < 7) {
    return { label: target.toLocaleDateString("en-US", { weekday: "long" }), soon: false };
  }
  return {
    label: target.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    soon: false,
  };
}

/**
 * The worklist.
 *
 * In pilot mode this page had no authentication and no tenant scoping: it
 * called `listBundles()` with no practice id, against the in-memory demo store.
 * It rendered empty, so it leaked nothing — but it was one data-source change
 * away from serving every practice's patients, and their access links, to any
 * anonymous visitor. The "Open link" column is a demo affordance for exactly
 * that reason and does not exist in pilot: a patient's link is delivered to the
 * patient, never displayed on a clinician's screen.
 */
export default async function ClinicianList() {
  let rows: ReturnType<typeof listRow>[];
  let heading = "Lakeview Dermatology · Dr. A. Sandoval";
  let dataLabel = "Synthetic demo data";
  let pilot = false;

  if (isPilot()) {
    pilot = true;
    // A page cannot throw a 401 usefully, so an unauthenticated visitor is sent
    // to sign in rather than shown an error.
    const ctx = await requireClinician().catch(() => null);
    if (!ctx) redirect("/clinician/sign-in");
    const s = await store();
    // Scoped in the query. The practice id comes from the signed session and
    // never from the URL.
    const bundles = await s.listBundles(ctx.practiceId);
    rows = bundles.map((b) => listRow(b));
    heading = `${bundles[0]?.practice.name ?? "Your practice"} · ${ctx.displayName}${ctx.credential ? `, ${ctx.credential}` : ""}`;
    dataLabel = "";
  } else {
    rows = listBundles().map(listRow);
  }

  const ready = rows.filter((r) => r.status === "ready_for_review");

  return (
    <main className="min-h-dvh-safe">
      <header className="border-b hairline bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-baseline gap-4">
            <Link href="/">
              <Brand size="sm" />
            </Link>
            <span className="text-sm text-muted">{heading}</span>
          </div>
          {dataLabel && <span className="text-xs text-muted">{dataLabel}</span>}
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-10">
        <h1 className="font-serif text-3xl tracking-[-0.02em] text-ink">Upcoming visits</h1>
        <p className="mt-2 text-[15px] text-ink-soft">
          {ready.length > 0
            ? `${ready.length} pre-visit brief${ready.length > 1 ? "s" : ""} ready to read.`
            : "No completed intakes waiting."}
        </p>

        <div className="mt-7 overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b hairline bg-paper text-[11px] uppercase tracking-[0.1em] text-muted">
                <th scope="col" className="px-5 py-3 font-medium">Patient</th>
                <th scope="col" className="hidden px-5 py-3 font-medium sm:table-cell">Visit</th>
                <th scope="col" className="px-5 py-3 font-medium">Concern</th>
                <th scope="col" className="hidden px-5 py-3 font-medium md:table-cell">Intake</th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {rows.map((r) => {
                const submitted = r.status === "ready_for_review" || r.status === "reviewed";
                return (
                  <tr key={r.id} className="align-top transition hover:bg-paper">
                    <td className="px-5 py-4">
                      <div className="font-medium text-ink">{r.patientName}</div>
                      <div className="text-[13px] text-muted">DOB {r.dateOfBirth}</div>
                    </td>
                    <td className="hidden px-5 py-4 text-[14px] sm:table-cell">
                      {(() => {
                        const when = relativeDay(r.scheduledFor);
                        return (
                          <span className={when.soon ? "font-medium text-ink" : "text-ink-soft"}>
                            {when.label}
                          </span>
                        );
                      })()}
                      <div className="text-[13px] text-muted">{r.reasonBooked}</div>
                    </td>
                    <td className="max-w-[26rem] px-5 py-4">
                      {submitted ? (
                        <>
                          <div className="text-[15px] leading-snug text-ink">{r.concern}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[12px] text-muted">
                            <span>{PATHWAY_LABELS[r.pathway]}</span>
                            {r.photoCount > 0 && <span>· {r.photoCount} photo{r.photoCount > 1 ? "s" : ""}</span>}
                            {r.openQuestionCount > 0 && (
                              <span className="text-flag">· {r.openQuestionCount} to clarify</span>
                            )}
                          </div>
                        </>
                      ) : (
                        <span className="text-[15px] text-muted">Not completed yet</span>
                      )}
                    </td>
                    <td className="hidden px-5 py-4 md:table-cell">
                      <span
                        className={`inline-block rounded-full px-2.5 py-1 text-[12px] ${
                          r.status === "ready_for_review"
                            ? "bg-accent-soft text-accent"
                            : r.status === "reviewed"
                              ? "bg-paper text-muted"
                              : "bg-paper text-muted"
                        }`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-right">
                      {submitted ? (
                        <Link
                          href={`/clinician/${r.id}`}
                          className="inline-block rounded-lg border border-line-strong px-3.5 py-1.5 text-[14px] font-medium text-ink transition hover:border-accent hover:text-accent"
                        >
                          Review
                        </Link>
                      ) : pilot ? (
                        // No link. The patient's token is the patient's
                        // credential; putting it on this screen would make every
                        // clinician's browser history a list of live patient
                        // links.
                        <span className="text-[14px] text-muted">Awaiting patient</span>
                      ) : (
                        <Link
                          href={`/intake/${r.token}`}
                          className="inline-block text-[14px] text-muted underline underline-offset-2 hover:text-ink"
                        >
                          Open link
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
