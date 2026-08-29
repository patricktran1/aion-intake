/**
 * Release gate.
 *
 *   npx tsx evals/gate.ts
 *
 * Exits non-zero when a SEMANTIC quality threshold regresses. These thresholds
 * gate merges — they are deliberately about product quality, not wording, so a
 * copy tweak never trips them but a fidelity or safety regression always does.
 * See EVALS.md for the rationale behind each number.
 */
import { selectCorpus } from "./corpus";
import { runCase } from "./lib/runner";
import { checkCase } from "./lib/checks";
import { scoreDimensions, metricsFrom } from "./lib/dimensions";
import type { CaseResult } from "./lib/types";

/** Hard gates. A value below `min` (or above `max`) fails the release. */
const GATES: { metric: string; min?: number; max?: number; why: string }[] = [
  { metric: "hpi_guard_clean_rate", min: 1.0, why: "an HPI may never contain an invented clinical claim" },
  { metric: "unsupported_numeric_claim_rate", max: 0.0, why: "a date or measurement the patient never gave is a fabrication" },
  { metric: "completion_robustness", min: 1.0, why: "the engine must never crash on any corpus input" },
  { metric: "clarify_cap_adherence", min: 1.0, why: "the clarify list must always stay readable" },
  { metric: "pathway_routing_accuracy", min: 0.9, why: "routing the wrong pathway asks the wrong questions" },
  { metric: "redundant_question_rate", max: 0.05, why: "re-asking what the patient already said erodes trust" },
  { metric: "case_pass_rate", min: 0.95, why: "the golden set encodes the behavioural contract" },
];

async function main() {
  const results: CaseResult[] = [];
  for (const c of selectCorpus("all")) {
    const a = await runCase(c);
    results.push(checkCase(c)(a));
  }
  const metrics = metricsFrom(scoreDimensions(results));

  let failed = 0;
  process.stdout.write("\nRELEASE GATE\n" + "─".repeat(60) + "\n");
  for (const g of GATES) {
    const v = metrics[g.metric];
    let ok = true;
    if (v === null || v === undefined) ok = false;
    else {
      if (typeof g.min === "number" && v < g.min) ok = false;
      if (typeof g.max === "number" && v > g.max) ok = false;
    }
    const bound = g.min !== undefined ? `≥ ${g.min}` : `≤ ${g.max}`;
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${g.metric.padEnd(32)} ${String(v).padStart(6)}  (need ${bound})\n`);
    if (!ok) {
      failed += 1;
      process.stdout.write(`      ↳ ${g.why}\n`);
    }
  }
  process.stdout.write("─".repeat(60) + "\n");
  if (failed > 0) {
    process.stdout.write(`GATE FAILED: ${failed} threshold(s) regressed.\n`);
    process.exit(1);
  }
  process.stdout.write("GATE PASSED.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
