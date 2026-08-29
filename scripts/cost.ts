/**
 * Measures the AI cost of a completed intake.
 *
 *   npx tsx scripts/cost.ts
 *
 * It does not call the API. It builds the exact payloads the product would send
 * — the same prompts, the same tool schema, the same trimmed transcript — and
 * counts their tokens, then applies the checked-in pricing. That makes the
 * number reproducible, free to compute, and honest about what drives it.
 *
 * Token counting is a character-based approximation (~3.6 chars per token for
 * English prose and JSON), deliberately conservative. When a key is configured,
 * the real usage numbers from the API replace this estimate on every intake and
 * are averaged at /api/metrics.
 */
import { SCENARIOS } from "../tests/fixtures/scenarios";
import { blankIntake } from "../src/lib/demo/seed";
import { conductTurn, startIntake } from "../src/lib/interview/conduct";
import { composeHpiDeterministic } from "../src/lib/ai/compose";
import {
  SYSTEM_HPI,
  SYSTEM_INTERVIEWER,
  TURN_TOOL,
  hpiUserPrompt,
  turnUserPrompt,
} from "../src/lib/ai/prompts";
import { DEFAULT_MODEL, PRICING, estimateCostUsd } from "../src/lib/ai/cost";
import { findSlot } from "../src/lib/interview/engine";
import type { Intake, IntakeBundle } from "../src/lib/domain/types";

/** Conservative character-to-token ratio for English prose and JSON. */
const CHARS_PER_TOKEN = 3.6;
const tokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

const TOOL_SCHEMA_TOKENS = tokens(JSON.stringify(TURN_TOOL));
const SYSTEM_TURN_TOKENS = tokens(SYSTEM_INTERVIEWER);
const SYSTEM_HPI_TOKENS = tokens(SYSTEM_HPI);

const bundleFor = (intake: Intake): IntakeBundle => ({
  intake,
  visit: { id: "v", practiceId: "p", patientId: "pt", scheduledFor: new Date().toISOString(), reasonBooked: "D", location: "L" },
  patient: { id: "pt", firstName: "Sim", lastName: "Patient", dateOfBirth: "1985-06-15" },
  practice: { id: "p", name: "P", clinicianName: "Dr. S", clinicianCredential: "MD" },
});

interface Measured {
  id: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

async function measure(scenario: (typeof SCENARIOS)[number]): Promise<Measured> {
  let intake = startIntake(blankIntake("v")).intake;
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;
  let next = scenario.opening;

  for (let i = 0; i < 20; i += 1) {
    const askedSlotId = intake.askedSlots[intake.askedSlots.length - 1];
    const askedSlot = findSlot(intake.pathway, askedSlotId);
    const transcript = intake.messages
      .slice(-2)
      .map((m) => `${m.role === "assistant" ? "AION" : "Patient"}: ${m.text}`)
      .join("\n");

    const result = await conductTurn({ intake, answer: next, inputMode: "text" });
    const nextQuestion = result.nextQuestion;

    // The turn call the product would have made for this answer.
    const user = turnUserPrompt({
      askedQuestion: askedSlot?.question ?? "",
      askedSlot: askedSlotId ?? "concern",
      facets: askedSlot?.facets ?? [],
      answer: next,
      nextQuestion,
      recentTranscript: transcript,
    });
    inputTokens += SYSTEM_TURN_TOKENS + TOOL_SCHEMA_TOKENS + tokens(user);
    // Output is the tool payload: extracted facts plus the next question.
    const facts = result.intake.facts.filter((f) => f.slot === askedSlotId);
    outputTokens += tokens(JSON.stringify(facts)) + tokens(nextQuestion ?? "") + 40;
    turns += 1;

    intake = result.intake;
    if (result.finished) break;
    const slot = intake.askedSlots[intake.askedSlots.length - 1];
    next = scenario.answerFor[slot] ?? scenario.fallback ?? "not sure";
  }

  // The one composition call at submission.
  const factLines = intake.facts
    .map((f) => `- ${f.slot} — ${f.value} — "${f.verbatim}" — ${f.certainty}`)
    .join("\n");
  const hpiUser = hpiUserPrompt({ age: 40, facts: factLines, photos: 0 });
  inputTokens += SYSTEM_HPI_TOKENS + tokens(hpiUser);
  outputTokens += tokens(composeHpiDeterministic(bundleFor(intake)));

  return { id: scenario.id, turns, inputTokens, outputTokens };
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;

async function main() {
  const results: Measured[] = [];
  for (const s of SCENARIOS) results.push(await measure(s));

  const model = DEFAULT_MODEL;
  const rows = results
    .map((r) => ({ ...r, cost: estimateCostUsd(model, r.inputTokens, r.outputTokens) }))
    .sort((a, b) => b.cost - a.cost);

  console.log(`${"scenario".padEnd(30)} calls   in-tok  out-tok      cost`);
  console.log("-".repeat(66));
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(30)} ${String(r.turns + 1).padStart(5)} ${String(r.inputTokens).padStart(8)} ${String(r.outputTokens).padStart(8)} ${usd(r.cost).padStart(9)}`,
    );
  }

  const mean = (f: (r: (typeof rows)[number]) => number) =>
    rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const meanIn = mean((r) => r.inputTokens);
  const meanOut = mean((r) => r.outputTokens);
  const meanCalls = mean((r) => r.turns + 1);
  const meanCost = mean((r) => r.cost);
  const p90 = rows[Math.floor(rows.length * 0.1)].cost;

  console.log("-".repeat(66));
  console.log(
    `mean  calls ${meanCalls.toFixed(1)}  in ${Math.round(meanIn)}  out ${Math.round(meanOut)}  cost ${usd(meanCost)}   p90 ${usd(p90)}`,
  );

  console.log("\nPer completed intake, by model:");
  for (const [name, p] of Object.entries(PRICING).filter(([n]) => !n.includes("2025"))) {
    const c = (meanIn * p.inputPerMTok + meanOut * p.outputPerMTok) / 1e6;
    console.log(`  ${name.padEnd(28)} ${usd(c)}`);
  }

  console.log("\nMonthly AI spend at volume (default model):");
  console.log(`  ${"intakes/month".padStart(9)}   ${"at mean".padStart(11)}   ${"at p90".padStart(11)}`);
  for (const v of [100, 1_000, 10_000, 100_000, 1_000_000]) {
    const label = v >= 1_000_000 ? `${v / 1_000_000}M` : v >= 1_000 ? `${v / 1_000}k` : String(v);
    console.log(
      `  ${label.padStart(9)}   ${usd(meanCost * v).padStart(11)}   ${usd(p90 * v).padStart(11)}`,
    );
  }
  console.log(`\n  deterministic mode (no API key)   ${usd(0)} at any volume`);

  // A pilot is the only volume anyone is committing to right now, so price it
  // explicitly rather than making a reader interpolate between the rows above.
  console.log("\nPilot envelope (5-20 dermatologists, 100-2,000 intakes/month):");
  console.log(`  floor    100 intakes/month   ${usd(meanCost * 100)}/mo`);
  console.log(`  ceiling  2,000 intakes/month ${usd(meanCost * 2_000)}/mo   (p90 ${usd(p90 * 2_000)}/mo)`);
}

void main();
