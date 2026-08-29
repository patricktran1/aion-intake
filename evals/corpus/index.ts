import type { EvalCase } from "../lib/types";
import { GOLDEN_CASES } from "./golden";
import { generatedCorpus } from "./generated";

/**
 * The full corpus. Golden cases carry the semantic contract; generated cases
 * provide breadth for aggregate robustness and economy metrics.
 */
export { GOLDEN_CASES };
export const GENERATED_CASES: EvalCase[] = generatedCorpus(240);
export const ALL_CASES: EvalCase[] = [...GOLDEN_CASES, ...GENERATED_CASES];

export function selectCorpus(which: "golden" | "generated" | "all"): EvalCase[] {
  if (which === "golden") return GOLDEN_CASES;
  if (which === "generated") return GENERATED_CASES;
  return ALL_CASES;
}
