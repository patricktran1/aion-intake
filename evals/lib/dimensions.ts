import { MAX_QUESTIONS } from "@/lib/interview/slots";
import type { CaseResult, DimensionScore } from "./types";

/**
 * Aggregate quality dimensions across the whole corpus.
 *
 * These are reported SEPARATELY, never collapsed into one score — a product with
 * perfect fidelity and mediocre question economy is a different thing from the
 * reverse, and a maintainer needs to see which is which.
 */

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 1000);

export function scoreDimensions(results: CaseResult[]): DimensionScore[] {
  const dims: DimensionScore[] = [];
  const push = (
    dimension: string,
    score: number | null,
    unit: string,
    detail: string,
    offenders: string[] = [],
  ) => dims.push({ dimension, score, unit, detail, offenders: offenders.slice(0, 12) });

  // --- Pathway routing accuracy (cases that assert a specific pathway) -------
  const routed = results.filter((r) => r.case.expectPathway !== "any");
  const routedOk = routed.filter((r) => r.artifacts.routedPathway === r.case.expectPathway);
  push(
    "pathway_routing_accuracy",
    pct(routedOk.length, routed.length),
    "fraction correct",
    `${routedOk.length}/${routed.length} routed to the expected pathway`,
    routed.filter((r) => r.artifacts.routedPathway !== r.case.expectPathway).map((r) => `${r.case.id}→${r.artifacts.routedPathway}`),
  );

  // --- Routing robustness on typo-mangled input (informational) -------------
  const typoCases = results.filter((r) => r.case.tags.includes("typos"));
  if (typoCases.length > 0) {
    // Recover the intended pathway from the case id (gen-<pathway>-typos-...).
    const typoOk = typoCases.filter((r) => {
      const intended = r.case.id.split("-")[1];
      return r.artifacts.routedPathway === intended;
    });
    push(
      "routing_robustness_typos",
      pct(typoOk.length, typoCases.length),
      "fraction (informational — model layer's job)",
      `${typoOk.length}/${typoCases.length} typo-mangled openers still routed correctly deterministically`,
      typoCases.filter((r) => r.case.id.split("-")[1] !== r.artifacts.routedPathway).map((r) => r.case.id),
    );
  }

  // --- Question economy ------------------------------------------------------
  const finished = results.filter((r) => r.artifacts.finished);
  const meanQ = finished.reduce((a, r) => a + r.artifacts.questionCount, 0) / (finished.length || 1);
  push(
    "mean_questions",
    Math.round(meanQ * 100) / 100,
    "questions (budget " + MAX_QUESTIONS + ")",
    `mean questions asked across ${finished.length} completed intakes`,
  );

  // --- Redundant-question rate ----------------------------------------------
  const totalAsked = finished.reduce((a, r) => a + Math.max(0, r.artifacts.askedSlots.length - 1), 0);
  const totalRedundant = finished.reduce((a, r) => a + r.artifacts.redundantQuestions.length, 0);
  push(
    "redundant_question_rate",
    pct(totalRedundant, totalAsked),
    "fraction of post-opener questions",
    `${totalRedundant}/${totalAsked} questions re-asked a slot the opener already settled (lower is better)`,
    finished.filter((r) => r.artifacts.redundantQuestions.length > 0).map((r) => `${r.case.id}:${r.artifacts.redundantQuestions.join("+")}`),
  );

  // --- HPI faithfulness — guard-clean rate (MUST be 1.0) ---------------------
  const guardClean = results.filter((r) => r.artifacts.guardViolations.length === 0);
  push(
    "hpi_guard_clean_rate",
    pct(guardClean.length, results.length),
    "fraction with zero guard violations",
    `${guardClean.length}/${results.length} HPIs contain no invented claims`,
    results.filter((r) => r.artifacts.guardViolations.length > 0).map((r) => `${r.case.id}:${r.artifacts.guardViolations.map((v) => v.kind).join(",")}`),
  );

  // --- Unsupported-claim rate (numeric / date fabrication specifically) ------
  const numericViol = results.filter((r) => r.artifacts.guardViolations.some((v) => v.kind === "unsourced_specific"));
  push(
    "unsupported_numeric_claim_rate",
    pct(numericViol.length, results.length),
    "fraction (MUST be 0)",
    `${numericViol.length}/${results.length} HPIs contain a date or measurement the patient never gave`,
    numericViol.map((r) => r.case.id),
  );

  // --- Completion robustness -------------------------------------------------
  const noCrash = results.filter((r) => !r.artifacts.crashed);
  push(
    "completion_robustness",
    pct(noCrash.length, results.length),
    "fraction that never crashed (MUST be 1.0)",
    `${noCrash.length}/${results.length} cases completed without throwing`,
    results.filter((r) => r.artifacts.crashed).map((r) => `${r.case.id}:${(r.artifacts.error ?? "").slice(0, 60)}`),
  );

  // --- Clarify discipline (cap never exceeded) -------------------------------
  const clarifyOk = results.filter((r) => r.artifacts.clarify.length <= 6);
  push(
    "clarify_cap_adherence",
    pct(clarifyOk.length, results.length),
    "fraction within the cap (MUST be 1.0)",
    `${clarifyOk.length}/${results.length} clarify lists stayed short enough to read`,
    results.filter((r) => r.artifacts.clarify.length > 6).map((r) => `${r.case.id}:${r.artifacts.clarify.length}`),
  );

  // --- Case pass rate (all semantic assertions) ------------------------------
  const passed = results.filter((r) => r.passed);
  push(
    "case_pass_rate",
    pct(passed.length, results.length),
    "fraction passing all assertions",
    `${passed.length}/${results.length} cases passed every semantic assertion`,
    results.filter((r) => !r.passed).map((r) => `${r.case.id}:${r.checks.filter((c) => !c.passed).map((c) => c.name).join(",")}`),
  );

  // --- Verbatim-preservation on the safety subcorpus not needed here; done via cases.

  return dims;
}

/** Flatten the dimensions into a metric map for baseline comparison. */
export function metricsFrom(dims: DimensionScore[]): Record<string, number | null> {
  const m: Record<string, number | null> = {};
  for (const d of dims) m[d.dimension] = d.score;
  return m;
}
