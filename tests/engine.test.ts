import { describe, expect, it } from "vitest";
import {
  classifyCertainty,
  computeOpenQuestions,
  coreComplete,
  detectPathway,
  detectUrgent,
  extractDeterministic,
  planNextQuestion,
} from "@/lib/interview/engine";
import { MAX_QUESTIONS, OPENING_SLOT, PATHWAY_SLOTS } from "@/lib/interview/slots";
import type { Fact, Pathway } from "@/lib/domain/types";

const fact = (slot: string, value = "something", certainty: Fact["certainty"] = "stated"): Fact => ({
  slot,
  value,
  verbatim: value,
  certainty,
  source: "patient",
  at: new Date().toISOString(),
});

describe("pathway detection", () => {
  it.each([
    ["I've had this itchy rash on my arms for three months", "rash"],
    ["there's a dark mole on my back that changed", "lesion"],
    ["my acne keeps breaking out along my jaw", "acne"],
    ["my hair is falling out in the shower", "hair_loss"],
  ])("routes %s to the %s pathway", (text, expected) => {
    expect(detectPathway(text)).toBe(expected as Pathway);
  });

  it("falls back to a general dermatology intake rather than failing", () => {
    expect(detectPathway("my toenails look strange and thick")).toBe("general");
  });

  it("never throws on empty or nonsense input", () => {
    expect(detectPathway("")).toBe("general");
    expect(detectPathway("asdkjhasd 8888 ???")).toBe("general");
  });
});

describe("urgent language detection", () => {
  it("flags language that warrants real care now", () => {
    expect(detectUrgent("the rash spread and now I'm having trouble breathing")).toBe(true);
  });
  it("does not flag ordinary dermatology complaints", () => {
    expect(detectUrgent("it itches a lot at night and keeps me awake")).toBe(false);
  });
});

describe("question planner", () => {
  const base = { pathway: "rash" as Pathway, facts: [] as Fact[], askedSlots: [] as string[], questionCount: 0 };

  it("opens with the same question regardless of pathway", () => {
    expect(planNextQuestion(base).slot?.id).toBe(OPENING_SLOT.id);
    expect(planNextQuestion({ ...base, pathway: "acne" }).slot?.id).toBe(OPENING_SLOT.id);
  });

  it("never repeats a slot that was already asked", () => {
    const plan = planNextQuestion({
      ...base,
      questionCount: 1,
      askedSlots: ["concern", "location"],
      facts: [fact("concern"), fact("location")],
    });
    expect(plan.slot?.id).not.toBe("location");
    expect(plan.slot?.id).not.toBe("concern");
  });

  it("asks core slots before conditional ones", () => {
    const plan = planNextQuestion({ ...base, questionCount: 1, askedSlots: ["concern"], facts: [fact("concern")] });
    expect(plan.slot?.tier).toBe("core");
  });

  it("reserves the final question for the patient's own goal", () => {
    const plan = planNextQuestion({
      ...base,
      questionCount: MAX_QUESTIONS - 1,
      askedSlots: ["concern"],
      facts: [fact("concern")],
    });
    expect(plan.slot?.id).toBe("goal");
  });

  it("stops at the question budget", () => {
    const plan = planNextQuestion({ ...base, questionCount: MAX_QUESTIONS, askedSlots: ["concern"] });
    expect(plan.slot).toBeNull();
    expect(plan.reason).toBe("budget_reached");
  });

  it("stops once every slot in the pathway is answered", () => {
    const all = PATHWAY_SLOTS.acne.map((s) => fact(s.id));
    const plan = planNextQuestion({
      pathway: "acne",
      facts: [fact("concern"), ...all],
      askedSlots: ["concern", ...PATHWAY_SLOTS.acne.map((s) => s.id)],
      questionCount: 5,
    });
    expect(plan.slot).toBeNull();
    expect(plan.reason).toBe("complete");
  });

  it("keeps every pathway within the question budget", () => {
    for (const pathway of ["rash", "lesion", "acne", "hair_loss", "general"] as Pathway[]) {
      const core = PATHWAY_SLOTS[pathway].filter((s) => s.tier === "core").length;
      // +1 for the opener; core questions must all fit inside the budget.
      expect(core + 1).toBeLessThanOrEqual(MAX_QUESTIONS);
    }
  });
});

describe("core completion", () => {
  it("is false until every core slot has a value", () => {
    expect(coreComplete({ pathway: "rash", facts: [fact("concern")] })).toBe(false);
  });
  it("is true once they do", () => {
    const facts = PATHWAY_SLOTS.rash.filter((s) => s.tier === "core").map((s) => fact(s.id));
    expect(coreComplete({ pathway: "rash", facts })).toBe(true);
  });
});

describe("certainty classification", () => {
  it("marks hedged answers approximate", () => {
    expect(classifyCertainty("I think around May")).toBe("approximate");
    expect(classifyCertainty("maybe three months")).toBe("approximate");
  });
  it("marks non-answers unclear", () => {
    expect(classifyCertainty("not sure")).toBe("unclear");
    expect(classifyCertainty("")).toBe("unclear");
  });
  it("marks plain answers as stated", () => {
    expect(classifyCertainty("Both arms and my neck")).toBe("stated");
  });
});

describe("deterministic extraction", () => {
  it("stores the patient's words untouched", () => {
    const [f] = extractDeterministic(OPENING_SLOT, "  it itches at night  ", "t");
    expect(f.verbatim).toBe("it itches at night");
    expect(f.value).toBe("It itches at night");
    expect(f.source).toBe("patient");
  });

  it("records nothing for an empty answer", () => {
    expect(extractDeterministic(OPENING_SLOT, "   ", "t")).toEqual([]);
  });
});

describe("open questions for the physician", () => {
  it("surfaces skipped questions", () => {
    const out = computeOpenQuestions({ pathway: "rash", facts: [], askedSlots: ["location"] });
    expect(out.some((q) => q.includes("skipped"))).toBe(true);
  });

  it("surfaces hedged answers as approximate rather than silently accepting them", () => {
    const out = computeOpenQuestions({
      pathway: "rash",
      facts: [fact("timeline", "Started around May", "approximate")],
      askedSlots: ["timeline"],
    });
    expect(out.some((q) => q.includes("Approximate only") || q.includes("approximate only"))).toBe(true);
  });

  it("surfaces core slots the budget never reached", () => {
    const out = computeOpenQuestions({ pathway: "rash", facts: [], askedSlots: [] });
    expect(out.some((q) => q.includes("question budget"))).toBe(true);
  });
});
