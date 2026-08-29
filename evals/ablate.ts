/**
 * Model ablation harness.
 *
 * Runs the golden corpus once per AION_MODEL_MODE and prints the dimensions
 * side by side, so "the model helps" becomes a number instead of a belief.
 *
 *   npx tsx evals/ablate.ts                  # every mode the key allows
 *   npx tsx evals/ablate.ts off full         # just these two
 *
 * With no ANTHROPIC_API_KEY set, only "off" is runnable; the harness says so
 * and exits cleanly rather than pretending it measured anything. That is the
 * state this repository ships in — the numbers in MODEL_EVAL.md marked
 * "deterministic" are real, and every model row is explicitly unmeasured.
 */

import { GOLDEN_CASES } from "./corpus/golden";
import { runCase } from "./lib/runner";
import { checkCase } from "./lib/checks";
import { scoreDimensions } from "./lib/dimensions";
import type { CaseResult, DimensionScore } from "./lib/types";
import type { ModelMode } from "@/lib/ai/client";

const ALL_MODES: ModelMode[] = ["off", "facts", "turn", "hpi", "full"];

async function runMode(mode: ModelMode): Promise<DimensionScore[]> {
  process.env.AION_MODEL_MODE = mode;
  const results: CaseResult[] = [];
  for (const c of GOLDEN_CASES) {
    const artifacts = await runCase(c);
    results.push(checkCase(c)(artifacts));
  }
  return scoreDimensions(results);
}

async function main() {
  const asked = process.argv.slice(2).filter((a): a is ModelMode =>
    (ALL_MODES as string[]).includes(a),
  );
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const modes = asked.length > 0 ? asked : hasKey ? ALL_MODES : (["off"] as ModelMode[]);

  if (!hasKey && modes.some((m) => m !== "off")) {
    console.error(
      "No ANTHROPIC_API_KEY set — model modes cannot be measured.\n" +
        "Running the deterministic baseline only. Set a key to fill in the rest.",
    );
  }
  const runnable = hasKey ? modes : modes.filter((m) => m === "off");

  const byMode = new Map<ModelMode, DimensionScore[]>();
  for (const mode of runnable) {
    process.stderr.write(`running mode=${mode} over ${GOLDEN_CASES.length} cases...\n`);
    byMode.set(mode, await runMode(mode));
  }

  const dimensions = [...byMode.values()][0]?.map((d) => d.dimension) ?? [];
  const pad = (s: string, n: number) => s.padEnd(n);
  const head = ["dimension".padEnd(32), ...runnable.map((m) => pad(m, 12))].join("");
  console.log(`\nMODEL ABLATION · ${GOLDEN_CASES.length} golden cases\n${"─".repeat(head.length)}`);
  console.log(head);
  for (const id of dimensions) {
    const cells = runnable.map((m) => {
      const d = byMode.get(m)!.find((x) => x.dimension === id);
      if (!d || d.score === null) return pad("—", 12);
      const v = d.unit.includes("fraction") ? `${Math.round(d.score * 100)}%` : d.score.toFixed(2);
      return pad(v, 12);
    });
    console.log([pad(id, 32), ...cells].join(""));
  }
  console.log("─".repeat(head.length));

  const json = Object.fromEntries(
    [...byMode].map(([m, ds]) => [m, Object.fromEntries(ds.map((d) => [d.dimension, d.score]))]),
  );
  console.log(`\n${JSON.stringify({ cases: GOLDEN_CASES.length, modes: json }, null, 2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
