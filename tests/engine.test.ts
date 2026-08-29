import { describe, expect, it } from "vitest";
import {
  classifyCertainty,
  computeOpenQuestions,
  isNonAnswer,
  stripFiller,
  stripSelfReference,
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

describe("clarify-in-visit", () => {
  /**
   * A realistic baseline: every rash core slot answered clearly, so a test can
   * perturb exactly one thing and see only that thing surface.
   */
  const completeRash = (overrides: Record<string, Fact> = {}) => {
    const base: Record<string, Fact> = {
      concern: fact("concern", "Itchy rash on both arms"),
      location: fact("location", "Both forearms, no spread"),
      timeline: fact("timeline", "Started three weeks ago, slowly worse"),
      symptoms: fact("symptoms", "Itchy, worse at night"),
      triggers: fact("triggers", "Hot showers make it worse"),
      treatments: fact("treatments", "Hydrocortisone, it helped for a week then stopped"),
      context: fact("context", "No medications"),
      goal: fact("goal", "Make it stop itching"),
    };
    const merged = { ...base, ...overrides };
    return {
      facts: Object.values(merged).filter((f) => f.value !== "__drop__"),
      askedSlots: Object.keys(merged),
    };
  };

  it("flags a high-value question the patient did not answer", () => {
    const out = computeOpenQuestions({ pathway: "rash", facts: [], askedSlots: ["location"] });
    expect(out.some((q) => q.includes("Location") && q.includes("did not answer"))).toBe(true);
  });

  it("ignores a low-value question the patient did not answer", () => {
    const { facts, askedSlots } = completeRash();
    const out = computeOpenQuestions({ pathway: "rash", facts, askedSlots: [...askedSlots, "exposures"] });
    expect(out).toEqual([]);
  });

  it("flags an approximate timeline, because timing changes the differential", () => {
    const { facts, askedSlots } = completeRash({
      timeline: fact("timeline", "Started around May I think", "approximate"),
    });
    const out = computeOpenQuestions({ pathway: "rash", facts, askedSlots });
    expect(out.some((q) => q.toLowerCase().includes("estimate"))).toBe(true);
  });

  it("does not flag an approximate answer that is not the timeline", () => {
    const { facts, askedSlots } = completeRash({
      triggers: fact("triggers", "Maybe heat", "approximate"),
    });
    expect(computeOpenQuestions({ pathway: "rash", facts, askedSlots })).toEqual([]);
  });

  it("flags a treatment the patient could not name", () => {
    const { facts, askedSlots } = completeRash({
      treatments: fact("treatments", "A cream my doctor gave me, it helped a bit"),
    });
    const out = computeOpenQuestions({ pathway: "rash", facts, askedSlots });
    expect(out.some((q) => q.includes("could not name"))).toBe(true);
  });

  it("flags a treatment whose response was never described", () => {
    const { facts, askedSlots } = completeRash({
      treatments: fact("treatments", "Hydrocortisone and Eucerin"),
    });
    const out = computeOpenQuestions({ pathway: "rash", facts, askedSlots });
    expect(out.some((q) => q.includes("response is not"))).toBe(true);
  });

  it("says nothing about a treatment that was named with its response", () => {
    const { facts, askedSlots } = completeRash();
    expect(computeOpenQuestions({ pathway: "rash", facts, askedSlots })).toEqual([]);
  });

  it("flags a core slot the interview never reached", () => {
    const { facts, askedSlots } = completeRash({ treatments: fact("treatments", "__drop__") });
    const out = computeOpenQuestions({
      pathway: "rash",
      facts,
      askedSlots: askedSlots.filter((s) => s !== "treatments"),
    });
    expect(out.some((q) => q.includes("not covered"))).toBe(true);
  });

  it("collapses a patient who answered almost nothing into one honest line", () => {
    const out = computeOpenQuestions({
      pathway: "rash",
      facts: [],
      askedSlots: ["location", "timeline", "symptoms", "treatments", "context"],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("answered very little");
  });

  it("leads with several concerns when the patient raised them", () => {
    const out = computeOpenQuestions({
      pathway: "general",
      facts: [fact("location", "Nose, shins and nails"), fact("timeline", "Varies")],
      askedSlots: ["location", "timeline"],
      concernCount: 3,
    });
    expect(out[0]).toContain("3 separate concerns");
  });

  it("never returns more than four items", () => {
    const out = computeOpenQuestions({
      pathway: "lesion",
      facts: [
        fact("concern", "A few things"),
        fact("lesion_timeline", "Maybe a year", "approximate"),
        fact("treatments", "some cream"),
      ],
      askedSlots: ["concern", "lesion_timeline", "lesion_symptoms", "location", "sun_history", "treatments"],
      concernCount: 2,
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("stays silent when a complete history left nothing to chase", () => {
    const { facts, askedSlots } = completeRash();
    expect(computeOpenQuestions({ pathway: "rash", facts, askedSlots })).toEqual([]);
  });
});

describe("non-answers", () => {
  it.each(["not sure", "idk", "dunno", "  ", "no idea", "I don't know", "?"])(
    "treats %s as carrying no information",
    (t) => {
      expect(isNonAnswer(t)).toBe(true);
    },
  );

  it.each([
    "Both arms and my neck",
    "I think around May, not sure exactly which week",
    "Nothing helps",
    "No",
  ])("treats %s as an answer", (t) => {
    expect(isNonAnswer(t)).toBe(false);
  });

  it("never stores a non-answer as a fact", () => {
    expect(extractDeterministic(OPENING_SLOT, "not sure", "t")).toEqual([]);
    expect(extractDeterministic(OPENING_SLOT, "idk", "t")).toEqual([]);
  });
});

describe("self-reference stripping", () => {
  it.each([
    ["I've had this itchy rash on both arms for months", "Itchy rash on both arms for months"],
    ["I keep breaking out along my jaw and chin", "Breaking out along my jaw and chin"],
    ["There's a dark spot on my upper back", "Dark spot on my upper back"],
    ["I noticed a new mole on my shoulder", "A new mole on my shoulder"],
  ])("turns %s into a line that reads like a record", (input, expected) => {
    expect(stripSelfReference(input)).toBe(expected);
  });

  it("leaves a concern that is already a noun phrase alone", () => {
    expect(stripSelfReference("Widening part with heavy shedding")).toBe(
      "Widening part with heavy shedding",
    );
    expect(stripSelfReference("My hair is coming out in handfuls")).toBe(
      "My hair is coming out in handfuls",
    );
  });

  it("never strips so much that nothing useful is left", () => {
    expect(stripSelfReference("I have a rash")).toBe("I have a rash");
    expect(stripSelfReference("I'm itchy")).toBe("I'm itchy");
  });

  it("only ever removes words, never introduces any", () => {
    const inputs = [
      "I've had this itchy rash on both arms",
      "There's a spot on my nose that keeps bleeding",
      "I get deep painful cystic pimples along my jaw",
    ];
    for (const input of inputs) {
      const out = stripSelfReference(input).toLowerCase();
      const source = input.toLowerCase();
      for (const word of out.split(/\s+/)) {
        expect(source, `"${word}" must come from the patient`).toContain(word.replace(/[^a-z']/g, ""));
      }
    }
  });
});

describe("filler stripping", () => {
  it("removes conversational throat-clearing from the front of an answer", () => {
    expect(stripFiller("OK so I've had a rash")).toBe("I've had a rash");
    expect(stripFiller("Um, well, it itches")).toBe("it itches");
  });

  it("leaves a clean answer alone", () => {
    expect(stripFiller("I've had a rash for three months")).toBe("I've had a rash for three months");
  });
});
