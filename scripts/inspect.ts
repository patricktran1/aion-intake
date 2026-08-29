/**
 * Interview inspector — a development tool, never shipped.
 *
 *   npx tsx scripts/inspect.ts "itchy rash on both arms for two weeks"
 *   npx tsx scripts/inspect.ts --case rash-contradiction-timeline
 *
 * Drives one interview and prints everything the engine decided and why:
 * which pathway it routed to, which slot each question targeted, what it
 * harvested from each answer without asking, which slots it skipped and
 * because of what, and the brief, HPI and clarify list at the end.
 *
 * This exists because the fastest way to debug a fidelity complaint is to see
 * the fact table beside the transcript. Reading it out of a failing test
 * assertion is how a ten-minute problem becomes an hour.
 */

import { conductTurn, startIntake } from "../src/lib/interview/conduct";
import { blankIntake } from "../src/lib/demo/seed";
import { buildBrief, composeHpiDeterministic, headline } from "../src/lib/ai/compose";
import { computeOpenQuestions, detectUrgent } from "../src/lib/interview/engine";
import { GOLDEN_CASES } from "../evals/corpus/golden";
import { evalBundle } from "../evals/lib/runner";
import type { Intake } from "../src/lib/domain/types";

const args = process.argv.slice(2);

function resolveInput(): { opening: string; answers: Record<string, string>; label: string } {
  const caseFlag = args.indexOf("--case");
  if (caseFlag !== -1) {
    const id = args[caseFlag + 1];
    const c = GOLDEN_CASES.find((x) => x.id === id);
    if (!c) {
      console.error(`No golden case "${id}". Available:\n  ${GOLDEN_CASES.map((x) => x.id).join("\n  ")}`);
      process.exit(1);
    }
    return { opening: c.opening, answers: c.answers ?? {}, label: c.id };
  }
  const opening = args.filter((a) => !a.startsWith("--")).join(" ");
  if (!opening) {
    console.error('Usage: npx tsx scripts/inspect.ts "opening answer" | --case <golden-id>');
    process.exit(1);
  }
  return { opening, answers: {}, label: "ad hoc" };
}

const rule = (s = "") => console.log(s ? `\n── ${s} ${"─".repeat(Math.max(0, 68 - s.length))}` : "─".repeat(72));

async function main() {
  const { opening, answers, label } = resolveInput();
  let intake: Intake = startIntake(blankIntake("v_inspect")).intake;

  console.log(`\nINSPECT · ${label}`);
  rule("transcript");
  console.log(`  AION    ${intake.messages[0].text}`);

  let next = opening;
  let factsSeen = 0;
  for (let turn = 0; turn < 16; turn += 1) {
    const askedSlot = intake.askedSlots[intake.askedSlots.length - 1];
    console.log(`  patient ${next || "(no answer)"}`);
    if (detectUrgent(next)) console.log("          ⚠ urgent language detected");

    const res = await conductTurn({ intake, answer: next, inputMode: "text" });
    intake = res.intake;

    // Anything gained beyond the slot we asked about was harvested.
    const gained = intake.facts.slice(factsSeen);
    factsSeen = intake.facts.length;
    for (const f of gained) {
      const how = f.slot === askedSlot ? "answered" : "harvested";
      console.log(`          + ${f.slot} [${how}, ${f.certainty}] ${f.value}`);
    }
    const outcome = intake.slotOutcomes[askedSlot];
    if (outcome && outcome !== "answered") console.log(`          · ${askedSlot} recorded as ${outcome}`);

    if (res.finished) break;
    console.log(`  AION    ${res.nextQuestion}`);
    next = answers[intake.askedSlots[intake.askedSlots.length - 1]] ?? "";
  }

  rule("routing");
  console.log(`  pathway        ${intake.pathway}`);
  console.log(`  questions      ${intake.questionCount}`);
  console.log(`  asked slots    ${intake.askedSlots.join(", ")}`);
  const settled = new Set(intake.facts.map((f) => f.slot));
  const harvested = [...settled].filter((s) => !intake.askedSlots.includes(s));
  console.log(`  never asked    ${harvested.length ? `${harvested.join(", ")} (harvested)` : "—"}`);

  rule("facts");
  for (const f of intake.facts) {
    console.log(`  ${f.slot.padEnd(18)} ${f.certainty.padEnd(12)} ${f.value}`);
    console.log(`  ${" ".repeat(18)} ${" ".repeat(12)} verbatim: "${f.verbatim}"`);
  }

  rule("brief");
  for (const section of buildBrief(intake)) {
    console.log(`  ${section.label}`);
    for (const item of section.items) console.log(`    · ${item.text}`);
  }

  rule("headline");
  console.log(`  ${headline(intake)}`);

  rule("clarify in visit");
  const open = computeOpenQuestions(intake);
  if (open.length === 0) console.log("  (nothing)");
  for (const q of open) console.log(`  · ${q}`);

  rule("draft HPI (deterministic)");
  console.log(
    composeHpiDeterministic(evalBundle(intake))
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n"),
  );
  rule();
}

void main();
