import type { Intake, IntakeBundle } from "@/lib/domain/types";
import { startIntake, conductTurn } from "@/lib/interview/conduct";
import { blankIntake } from "@/lib/demo/seed";
import { buildBrief, composeHpiDeterministic } from "@/lib/ai/compose";
import { guardAll } from "@/lib/ai/guard";
import type { EvalCase, RunArtifacts } from "./types";

/**
 * Drives one case through the REAL engine, deterministically, and captures
 * everything a scorer needs. No mocks — this is the production interview loop.
 *
 * The one measurement that needs care is redundancy: a question is redundant if
 * the engine asks about a slot the opening answer already settled (a non-partial
 * fact). A narrowed follow-up on a *partial* fact is intended, not redundant, so
 * it is excluded.
 */

/** A synthetic bundle so the composers can run. Patient is fixed and synthetic. */
export function evalBundle(intake: Intake): IntakeBundle {
  return {
    intake,
    visit: {
      id: "v_eval",
      practiceId: "p_eval",
      patientId: "pt_eval",
      scheduledFor: "2026-09-01T12:00:00.000Z",
      reasonBooked: "Dermatology",
      location: "Eval",
    },
    patient: { id: "pt_eval", firstName: "Eval", lastName: "Patient", dateOfBirth: "1986-03-10" },
    practice: { id: "p_eval", name: "Eval Dermatology", clinicianName: "Dr. Eval", clinicianCredential: "MD" },
  };
}

const settledSlots = (intake: Intake): string[] => {
  const bySlot = new Map<string, boolean>();
  for (const f of intake.facts) {
    if (!f.value.trim()) continue;
    // A slot is settled if it has at least one non-partial fact.
    bySlot.set(f.slot, (bySlot.get(f.slot) ?? false) || f.partial !== true);
  }
  return [...bySlot.entries()].filter(([, settled]) => settled).map(([slot]) => slot);
};

export async function runCase(c: EvalCase): Promise<RunArtifacts> {
  let intake = startIntake(blankIntake("v_eval")).intake;
  let settledAfterOpener: string[] = [];
  const fallback = c.fallback ?? "";
  let crashed = false;
  let error: string | undefined;
  let finished = false;

  try {
    let next = c.opening;
    for (let turn = 0; turn < 16; turn += 1) {
      const r = await conductTurn({ intake, answer: next, inputMode: "text" });
      intake = r.intake;
      if (turn === 0) settledAfterOpener = settledSlots(intake);
      if (r.finished) {
        finished = true;
        break;
      }
      const askedSlot = intake.askedSlots[intake.askedSlots.length - 1];
      next = c.answers[askedSlot] ?? fallback;
    }
  } catch (e) {
    crashed = true;
    error = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  }

  const postOpenerAsked = intake.askedSlots.slice(1);
  const settledSet = new Set(settledAfterOpener);
  const redundantQuestions = postOpenerAsked.filter((s) => settledSet.has(s));

  const bundle = evalBundle(intake);
  let hpi = "";
  let briefRows: RunArtifacts["briefRows"] = [];
  let guardViolations: RunArtifacts["guardViolations"] = [];
  try {
    hpi = composeHpiDeterministic(bundle);
    briefRows = buildBrief(intake).flatMap((s) =>
      s.items.map((i) => ({ label: s.label, slot: i.slot, text: i.text, verbatim: i.verbatim, certainty: i.certainty })),
    );
    const sources = intake.facts.flatMap((f) => [f.verbatim, f.value]);
    guardViolations = guardAll(hpi, sources);
  } catch (e) {
    crashed = true;
    error = (error ? error + " | " : "") + (e instanceof Error ? e.message : String(e));
  }

  return {
    id: c.id,
    routedPathway: intake.pathway,
    questionCount: intake.questionCount,
    askedSlots: intake.askedSlots,
    settledAfterOpener,
    redundantQuestions,
    facts: intake.facts.map((f) => ({
      slot: f.slot,
      value: f.value,
      verbatim: f.verbatim,
      certainty: f.certainty,
      harvested: f.harvested === true,
      partial: f.partial === true,
    })),
    briefRows,
    hpi,
    clarify: [...intake.openQuestions, ...intake.patientQuestions],
    urgentFlag: intake.urgentFlag,
    finished,
    crashed,
    error,
    guardViolations,
  };
}
