/**
 * AION Eval Lab — shared types.
 *
 * A case is a scripted patient plus *semantic* expectations. We never assert a
 * literal transcript, because several valid interviews can gather the same
 * story; we assert what a dermatologist would actually care about — the right
 * pathway, the facts preserved, the claims prohibited, the uncertainty kept.
 */
import type { Pathway } from "@/lib/domain/types";

/** A scripted patient. Answers are keyed by the slot the engine is asking. */
export interface EvalCase {
  id: string;
  /** rash | lesion | acne | hair_loss | general — or "any" when routing is not the point. */
  expectPathway: Pathway | "any";
  /** The first thing the patient says. */
  opening: string;
  /** Answers keyed by slot id. Unmatched slots fall through to `fallback`. */
  answers: Record<string, string>;
  /** Used when a slot has no keyed answer. Default: skip (empty string). */
  fallback?: string;
  /** What this case is probing — shown in reports. */
  probes: string;
  /** Dimension tags so a report can slice by concern. */
  tags: string[];
  assert?: CaseAssertions;
}

export interface CaseAssertions {
  /** Substrings that must each appear in at least one brief value (case-insensitive). */
  mustPreserve?: string[];
  /** The patient's exact phrasing that must survive verbatim somewhere in the brief/HPI. */
  mustPreserveVerbatim?: string[];
  /** Regexes/substrings that must NEVER appear in the brief or HPI (invented claims). */
  prohibited?: (string | RegExp)[];
  /** A slot whose fact must carry this certainty. */
  certainty?: { slot: string; is: "stated" | "approximate" | "unclear" }[];
  /** A substring that must appear in the clarify-in-visit list. */
  expectClarify?: string[];
  /** The clarify list must be empty (a complete, unambiguous history). */
  clarifyEmpty?: boolean;
  /** Upper bound on questions asked (opener counts as 1). */
  maxQuestions?: number;
  /** The engine must not re-ask anything the opener already answered. */
  noRedundantQuestions?: boolean;
  /** Urgent language must (or must not) raise the flag. */
  urgentFlag?: boolean;
  /** A slot that must end up with at least one fact. */
  mustHaveFact?: string[];
  /** A slot that must NOT have a fact (e.g. a non-answer was given). */
  mustNotHaveFact?: string[];
}

/** Everything one run produced, ready for scoring. */
export interface RunArtifacts {
  id: string;
  routedPathway: Pathway;
  questionCount: number;
  askedSlots: string[];
  /** Slots settled (non-partial fact) immediately after the opening answer. */
  settledAfterOpener: string[];
  /** Post-opener asked slots that were already settled by the opener. */
  redundantQuestions: string[];
  facts: { slot: string; value: string; verbatim: string; certainty: string; harvested: boolean; partial: boolean }[];
  briefRows: { label: string; slot: string; text: string; verbatim: string; certainty: string }[];
  hpi: string;
  clarify: string[];
  urgentFlag: boolean;
  finished: boolean;
  /** True if any turn threw. A robust engine never does. */
  crashed: boolean;
  error?: string;
  /** Guard violations found in the deterministic HPI. Must be zero. */
  guardViolations: { kind: string; detail: string }[];
}

export interface CaseResult {
  case: EvalCase;
  artifacts: RunArtifacts;
  checks: AssertionCheck[];
  passed: boolean;
}

export interface AssertionCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DimensionScore {
  dimension: string;
  /** 0..1, or null if not applicable to the corpus slice. */
  score: number | null;
  unit: string;
  detail: string;
  /** Cases that dragged the score down, for the report. */
  offenders: string[];
}

export interface EvalReport {
  generatedAt: string;
  corpusSize: number;
  casesPassed: number;
  casesFailed: number;
  failing: { id: string; failed: string[] }[];
  dimensions: DimensionScore[];
  metrics: Record<string, number | null>;
}
