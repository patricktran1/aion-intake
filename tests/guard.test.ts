import { describe, expect, it } from "vitest";
import { guardAll, guardDiagnosisTerms, guardNarrative, isSafeQuestion } from "@/lib/ai/guard";

const SOURCES = [
  "I've had this itchy rash on both my arms for about three months",
  "I think around May",
  "I take levothyroxine. I'm allergic to sulfa drugs — I get hives.",
];

describe("hallucination guard", () => {
  it("catches a negative the patient never stated", () => {
    const v = guardNarrative("The patient denies fever or systemic symptoms.", SOURCES);
    expect(v.some((x) => x.kind === "invented_negative")).toBe(true);
  });

  it("catches NKDA, the classic fabricated negative", () => {
    const v = guardNarrative("No known drug allergies.", SOURCES);
    expect(v.some((x) => x.kind === "invented_negative")).toBe(true);
  });

  it("catches examination findings nobody could have made yet", () => {
    const v = guardNarrative(
      "On exam there are erythematous plaques over the antecubital fossae.",
      SOURCES,
    );
    expect(v.some((x) => x.kind === "exam_finding")).toBe(true);
  });

  it("catches an assessment or a plan", () => {
    expect(
      guardNarrative("This is most likely represents an atopic flare.", SOURCES).some(
        (x) => x.kind === "assessment_or_plan",
      ),
    ).toBe(true);
    expect(
      guardNarrative("Recommend a topical steroid.", SOURCES).some(
        (x) => x.kind === "assessment_or_plan",
      ),
    ).toBe(true);
  });

  it("catches a hedge sharpened into a specific date", () => {
    const v = guardNarrative("The rash began May 1 and has worsened since.", SOURCES);
    expect(v.some((x) => x.kind === "unsourced_specific")).toBe(true);
  });

  it("catches a measurement the patient never gave", () => {
    const v = guardNarrative("A 6 mm lesion is present on the back.", SOURCES);
    expect(v.some((x) => x.kind === "unsourced_specific")).toBe(true);
  });

  it("catches a diagnosis name the summary introduced", () => {
    const v = guardDiagnosisTerms("Findings are typical of atopic eczema.", SOURCES);
    expect(v).toHaveLength(1);
  });

  it("allows a diagnosis name the patient used themselves", () => {
    const v = guardDiagnosisTerms("Patient reports having had eczema as a child.", [
      "I had eczema as a kid",
    ]);
    expect(v).toHaveLength(0);
  });

  it("allows a faithful summary of what the patient actually said", () => {
    const clean =
      "Patient reports an itchy rash on both arms for about three months. They describe the onset as \"I think around May\". They take levothyroxine and report a sulfa allergy causing hives.";
    expect(guardAll(clean, SOURCES)).toHaveLength(0);
  });
});

describe("question safety guard", () => {
  it("accepts a plainly worded interview question", () => {
    expect(isSafeQuestion("Where did you first notice it, and has it spread anywhere?")).toBe(true);
  });

  it("rejects a question that slips in an opinion about the condition", () => {
    expect(isSafeQuestion("That sounds like eczema — how long has it been there?")).toBe(false);
  });

  it("rejects reassurance", () => {
    expect(isSafeQuestion("Nothing to worry about — when did it start?")).toBe(false);
  });

  it("rejects advice", () => {
    expect(isSafeQuestion("You should try a moisturiser. Does it itch?")).toBe(false);
  });

  it("rejects anything that raises cancer or urgency with the patient", () => {
    expect(isSafeQuestion("Are you worried it might be cancer?")).toBe(false);
  });

  it("rejects a statement that is not a question at all", () => {
    expect(isSafeQuestion("Thanks for sharing that with me.")).toBe(false);
  });
});
