/**
 * AION Eval Lab entrypoint.
 *
 *   npx tsx evals/run.ts                 # full corpus, terminal scorecard
 *   npx tsx evals/run.ts --golden        # golden set only
 *   npx tsx evals/run.ts --write         # also write evals/results/latest.{json,md}
 *   npx tsx evals/run.ts --baseline      # write evals/baseline.json (records a new baseline)
 *   npx tsx evals/run.ts --json          # print machine-readable JSON only
 *
 * Runs entirely offline against the deterministic engine — no deployment, no API
 * key. See EVALS.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { selectCorpus } from "./corpus";
import { runCase } from "./lib/runner";
import { checkCase } from "./lib/checks";
import { scoreDimensions } from "./lib/dimensions";
import { buildReport, markdownReport, terminalReport } from "./lib/report";
import type { CaseResult, EvalReport } from "./lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");
const BASELINE = join(HERE, "baseline.json");

async function main() {
  const args = process.argv.slice(2);
  const which = args.includes("--golden") ? "golden" : args.includes("--generated") ? "generated" : "all";
  const corpus = selectCorpus(which);

  const results: CaseResult[] = [];
  for (const c of corpus) {
    const artifacts = await runCase(c);
    results.push(checkCase(c)(artifacts));
  }

  const dims = scoreDimensions(results);
  // A fixed timestamp keeps the artifact stable in tests unless data changes.
  const now = new Date().toISOString();
  const report = buildReport(results, dims, now);

  const baseline: EvalReport | null = existsSync(BASELINE)
    ? (JSON.parse(readFileSync(BASELINE, "utf8")) as EvalReport)
    : null;

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report;
  }

  process.stdout.write(terminalReport(report, baseline) + "\n");

  if (args.includes("--detail")) {
    for (const r of results.filter((x) => !x.passed)) {
      process.stdout.write(`\n── ${r.case.id} ── ${r.case.probes}\n`);
      for (const c of r.checks.filter((x) => !x.passed)) {
        process.stdout.write(`   FAIL ${c.name}: ${c.detail}\n`);
      }
      process.stdout.write(`   pathway=${r.artifacts.routedPathway} q=${r.artifacts.questionCount} facts=${r.artifacts.facts.map((f) => f.slot).join(",")}\n`);
      process.stdout.write(`   HPI: ${r.artifacts.hpi.replace(/\n/g, " ⏎ ").slice(0, 400)}\n`);
      process.stdout.write(`   CLARIFY: ${r.artifacts.clarify.join(" | ")}\n`);
    }
  }

  if (args.includes("--write")) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, "latest.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(RESULTS_DIR, "latest.md"), markdownReport(report, baseline));
    process.stdout.write(`\nWrote evals/results/latest.{json,md}\n`);
  }
  if (args.includes("--baseline")) {
    writeFileSync(BASELINE, JSON.stringify(report, null, 2));
    process.stdout.write(`\nWrote evals/baseline.json — future runs compare against this.\n`);
  }
  return report;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
