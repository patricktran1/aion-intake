import { describe, expect, it } from "vitest";
import { detectUrgent } from "@/lib/interview/engine";
import { isGroundedRestatement } from "@/lib/interview/conduct";
import { guardDiagnosisTerms, guardNarrative, isSafeQuestion } from "@/lib/ai/guard";
import { MAX_QUESTIONS } from "@/lib/interview/slots";

/**
 * Mutation pins.
 *
 * The coverage critic ran mutation experiments against the suite and found
 * guards whose deletion no test caught: individual detectUrgent rules, most
 * guardNarrative patterns, the isSafeQuestion scope patterns and length
 * bounds, the isGroundedRestatement numeric hard-fail, and the MAX_QUESTIONS
 * ceiling. Each test here exists so that removing exactly one guard turns the
 * suite red. Keep them one-guard-per-case; a broad test that several patterns
 * could satisfy pins nothing.
 */

describe("detectUrgent: every rule family is individually load-bearing", () => {
  // One positive per rule in URGENT_RULES, in source order. Deleting any
  // single rule must fail at least one of these.
  it.each([
    "some days I just want to kill myself",
    "I have been having suicidal thoughts",
    "honestly I want to die",
    "there is no reason to go on",
    "I don't want to be here anymore",
    "I keep thinking about hurting myself",
    "I might harm myself", // bare self-harm, no accident context
    "I can't breathe when I lie down",
    "shortness of breath since this started",
    "I am wheezing all night",
    "I can't catch my breath",
    "my throat is closing up",
    "the ER said anaphylaxis last time",
    "I think this is an allergic reaction",
    "my tongue is swelling",
    "there is swelling of my face and neck",
    "crushing chest pain since this morning",
    "I fainted twice this week",
    "I have a high fever with this rash",
    "red streaks going up from the wound",
    "the redness is spreading fast up my leg",
    "it is spreading rapidly across my chest",
    "the urgent care said cellulitis",
    "my skin is peeling off in sheets",
    "I have blisters in my mouth",
    "my whole body is covered in this rash",
    "they mentioned sepsis at the hospital",
  ])("flags: %s", (t) => {
    expect(detectUrgent(t)).toBe(true);
  });

  // One negative per `unless` guard. Deleting any single unless must fail one.
  it.each([
    "I hurt myself shaving this morning, just a nick",
    "the spot gives me chest pain when I press on it",
    "I had a high fever as a kid with measles, this is different",
  ])("does not flag: %s", (t) => {
    expect(detectUrgent(t)).toBe(false);
  });
});

describe("isGroundedRestatement: numeric hard-fail is independent of word overlap", () => {
  it("rejects a fabricated number even when every other word matches", () => {
    // 3/4 content words match ("rash", "for", "weeks") — over the 0.6 overlap
    // bar — so only the numeric hard-fail can reject this.
    expect(isGroundedRestatement("Rash for 3 weeks", "I have had this rash for weeks and weeks now")).toBe(
      false,
    );
  });

  it("accepts the same number when the patient said it", () => {
    expect(isGroundedRestatement("Rash for 3 weeks", "I have had this rash for 3 weeks now")).toBe(true);
  });
});

describe("guardNarrative: each pattern class fires on unsourced text", () => {
  const flags = (text: string) => guardNarrative(text, ["itchy rash on my arms for a while"]);

  // NEGATIVE_PATTERNS — one per regex.
  it.each([
    ["denies fever", "invented_negative"],
    ["no history of skin cancer", "invented_negative"],
    ["negative for systemic symptoms", "invented_negative"],
    ["no known drug allergies", "invented_negative"],
    ["NKDA", "invented_negative"],
    ["without fever or chills", "invented_negative"],
    ["not associated with new exposures", "invented_negative"],
    ["no fever reported", "invented_negative"],
  ])("flags negative: %s", (text, kind) => {
    expect(flags(text).some((v) => v.kind === kind)).toBe(true);
  });

  // EXAM_PATTERNS — one per regex.
  it.each([
    "on physical exam the rash is diffuse",
    "an erythematous patch",
    "excoriated papules noted",
    "lichenified plaques on the flexures",
    "a well-demarcated plaque",
    "scattered pustules on the chest",
    "asymmetric border of the lesion",
    "patient is afebrile",
    "vital signs stable",
    "dermoscopy shows a network",
    "tender to palpation",
  ])("flags exam finding: %s", (text) => {
    expect(flags(text).some((v) => v.kind === "exam_finding")).toBe(true);
  });

  // ASSESSMENT_PATTERNS — one per regex.
  it.each([
    "Assessment: dermatitis",
    "Plan: topical steroid",
    "the differential includes tinea",
    "consistent with eczema",
    "suggestive of contact allergy",
    "most likely represents irritation",
    "likely a fungal process",
    "concerning for malignancy",
    "recommend a biopsy",
    "we will start a topical",
    "prescribed triamcinolone",
    "biopsy is indicated",
    "working diagnosis of dermatitis",
    "rule out tinea",
  ])("flags assessment/plan: %s", (text) => {
    expect(flags(text).some((v) => v.kind === "assessment_or_plan")).toBe(true);
  });

  // SPECIFIC_PATTERNS — one per regex.
  it.each(["symptoms began March 12", "worsening since 3/12/2024", "a 5 mm lesion"])(
    "flags unsourced specific: %s",
    (text) => {
      expect(flags(text).some((v) => v.kind === "unsourced_specific")).toBe(true);
    },
  );
});

describe("guardDiagnosisTerms: every diagnosis word is individually pinned", () => {
  const WORDS = [
    "eczema",
    "psoriasis",
    "melanoma",
    "basal cell",
    "squamous cell",
    "rosacea",
    "tinea",
    "scabies",
    "lichen planus",
    "alopecia areata",
    "androgenetic",
    "seborrheic dermatitis",
    "contact dermatitis",
    "folliculitis",
    "hidradenitis",
  ];

  it.each(WORDS)("flags introduced term: %s", (w) => {
    expect(guardDiagnosisTerms(`this may be ${w}`, ["itchy rash on my arm"])).toHaveLength(1);
  });

  it.each(WORDS)("allows patient-sourced term: %s", (w) => {
    expect(guardDiagnosisTerms(`patient reports prior ${w}`, [`I was told it was ${w} before`])).toHaveLength(
      0,
    );
  });
});

describe("isSafeQuestion: scope patterns and bounds are each load-bearing", () => {
  it.each([
    "What diagnosis do you think this is?",
    "Should we prescribe something for it?",
    "Would a treatment plan involving steroids help?",
    "Is your assessment that it itches at night?",
  ])("blocks diagnose/prescribe/plan phrasing: %s", (q) => {
    expect(isSafeQuestion(q)).toBe(false);
  });

  it("blocks a too-short question", () => {
    expect(isSafeQuestion("ok?")).toBe(false);
  });

  it("blocks an over-length question", () => {
    expect(isSafeQuestion(`${"did the itch get worse at night ".repeat(12)}?`)).toBe(false);
  });

  it("blocks a statement with no question mark", () => {
    expect(isSafeQuestion("Tell me more about when the rash started.")).toBe(false);
  });

  it("still allows the engine's own phrasing shape", () => {
    expect(isSafeQuestion("When did you first notice the rash?")).toBe(true);
  });
});

describe("MAX_QUESTIONS: the patient-fatigue ceiling is an absolute number", () => {
  it("is at most 9 — raising the budget is a product decision, not a refactor", () => {
    expect(MAX_QUESTIONS).toBeLessThanOrEqual(9);
  });
});
