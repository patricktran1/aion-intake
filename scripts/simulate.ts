/**
 * Runs every synthetic scenario through the real interview engine and prints
 * the resulting transcript, brief, clarify list and draft HPI.
 *
 *   npx tsx scripts/simulate.ts            # all scenarios, summary table
 *   npx tsx scripts/simulate.ts rash       # full detail for matching ids
 *
 * This is the tool the interview and composer work is done against. Reading
 * thirty briefs side by side surfaces repetition and padding that no single
 * test would catch.
 */
import { SCENARIOS, type Scenario } from "../tests/fixtures/scenarios";
import { blankIntake } from "../src/lib/demo/seed";
import { conductTurn, startIntake } from "../src/lib/interview/conduct";
import { buildBrief, composeHpiDeterministic, headline } from "../src/lib/ai/compose";
import type { Intake, IntakeBundle } from "../src/lib/domain/types";

const bundleFor = (intake: Intake): IntakeBundle => ({
  intake,
  visit: {
    id: "vis_sim",
    practiceId: "prac_sim",
    patientId: "pat_sim",
    scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    reasonBooked: "Dermatology",
    location: "Sim",
  },
  patient: { id: "pat_sim", firstName: "Sim", lastName: "Patient", dateOfBirth: "1985-06-15" },
  practice: {
    id: "prac_sim",
    name: "Sim Dermatology",
    clinicianName: "Dr. Sim",
    clinicianCredential: "MD",
  },
});

export interface RunResult {
  scenario: Scenario;
  intake: Intake;
  questions: string[];
  answers: string[];
  brief: ReturnType<typeof buildBrief>;
  hpi: string;
  headline: string;
}

export async function run(scenario: Scenario): Promise<RunResult> {
  let intake = startIntake(blankIntake("vis_sim")).intake;
  const questions: string[] = [intake.messages[0].text];
  const answers: string[] = [];

  let next = scenario.opening;
  for (let i = 0; i < 20; i += 1) {
    answers.push(next);
    const result = await conductTurn({ intake, answer: next, inputMode: "text" });
    intake = result.intake;
    if (result.finished) break;
    questions.push(result.nextQuestion ?? "");
    const slot = intake.askedSlots[intake.askedSlots.length - 1];
    next = scenario.answerFor[slot] ?? scenario.fallback ?? "not sure";
  }

  return {
    scenario,
    intake,
    questions,
    answers,
    brief: buildBrief(intake),
    hpi: composeHpiDeterministic(bundleFor(intake)),
    headline: headline(intake),
  };
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function printDetail(r: RunResult) {
  const ok = r.intake.pathway === r.scenario.expectPathway ? "✓" : "✗";
  console.log("\n" + "═".repeat(78));
  console.log(`${r.scenario.id}   pathway ${r.intake.pathway} ${ok} (expected ${r.scenario.expectPathway})`);
  console.log(`probes: ${r.scenario.probes}`);
  console.log("─".repeat(78));
  console.log("TRANSCRIPT");
  r.questions.forEach((q, i) => {
    console.log(`  Q${i + 1} [${r.intake.askedSlots[i] ?? "?"}] ${q}`);
    if (r.answers[i] !== undefined) console.log(`     A: ${clip(r.answers[i], 150)}`);
  });
  console.log("─".repeat(78));
  console.log(`HEADLINE: ${r.headline}`);
  console.log("─".repeat(78));
  console.log("BRIEF");
  for (const s of r.brief) {
    for (const it of s.items) {
      const mark = it.certainty === "stated" ? " " : it.certainty === "approximate" ? "~" : "?";
      console.log(`  ${mark} ${s.label.padEnd(24)} ${clip(it.text, 110)}`);
    }
  }
  console.log("─".repeat(78));
  console.log("CLARIFY IN VISIT");
  if (r.intake.patientQuestions.length === 0 && r.intake.openQuestions.length === 0) {
    console.log("  (none)");
  }
  r.intake.patientQuestions.forEach((q) => console.log(`  ! patient asked: ${clip(q, 100)}`));
  r.intake.openQuestions.forEach((q) => console.log(`  · ${clip(q, 110)}`));
  console.log("─".repeat(78));
  console.log("DRAFT HPI");
  r.hpi.split("\n").forEach((l) => console.log(`  ${clip(l, 112)}`));
}

async function main() {
  const filter = process.argv[2];
  const chosen = filter ? SCENARIOS.filter((s) => s.id.includes(filter)) : SCENARIOS;
  const results: RunResult[] = [];
  for (const s of chosen) results.push(await run(s));

  if (filter) {
    results.forEach(printDetail);
    return;
  }

  console.log(
    `${"scenario".padEnd(30)} ${"pathway".padEnd(11)} Qs  facts  brief  clarify  hpi-lines`,
  );
  console.log("─".repeat(90));
  for (const r of results) {
    const ok = r.intake.pathway === r.scenario.expectPathway ? " " : "✗";
    const briefItems = r.brief.reduce((a, s) => a + s.items.length, 0);
    const clarify = r.intake.openQuestions.length + r.intake.patientQuestions.length;
    console.log(
      `${ok}${r.scenario.id.padEnd(29)} ${r.intake.pathway.padEnd(11)} ${String(r.intake.questionCount).padStart(2)}  ${String(r.intake.facts.length).padStart(5)}  ${String(briefItems).padStart(5)}  ${String(clarify).padStart(7)}  ${String(r.hpi.split("\n").length).padStart(9)}`,
    );
  }
  const avgQ = results.reduce((a, r) => a + r.intake.questionCount, 0) / results.length;
  const avgClarify =
    results.reduce((a, r) => a + r.intake.openQuestions.length + r.intake.patientQuestions.length, 0) /
    results.length;
  const wrong = results.filter((r) => r.intake.pathway !== r.scenario.expectPathway);
  console.log("─".repeat(90));
  console.log(`${results.length} scenarios · mean questions ${avgQ.toFixed(1)} · mean clarify items ${avgClarify.toFixed(1)}`);
  if (wrong.length) console.log(`MISROUTED: ${wrong.map((w) => `${w.scenario.id}→${w.intake.pathway}`).join(", ")}`);
}

void main();
