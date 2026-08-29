import { beforeEach, describe, expect, it } from "vitest";
import { conductTurn, generateHpi, parseTurn, startIntake } from "@/lib/interview/conduct";
import { blankIntake, seedData } from "@/lib/demo/seed";
import { MAX_QUESTIONS, OPENING_SLOT } from "@/lib/interview/slots";
import type { Intake, IntakeBundle } from "@/lib/domain/types";
import { resetAnalytics } from "@/lib/analytics";

/** No API key in the test environment, so every run exercises the deterministic path. */
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  resetAnalytics();
});

const fresh = (): Intake => blankIntake("vis_test");

async function answer(intake: Intake, text: string, mode: "text" | "voice" = "text") {
  return conductTurn({ intake, answer: text, inputMode: mode });
}

describe("intake state transitions", () => {
  it("moves from not_started to in_progress and asks the opener", () => {
    const r = startIntake(fresh());
    expect(r.intake.status).toBe("in_progress");
    expect(r.intake.questionCount).toBe(1);
    expect(r.nextQuestion).toBe(OPENING_SLOT.question);
    expect(r.intake.askedSlots).toEqual([OPENING_SLOT.id]);
  });

  it("chooses the pathway from the opening answer", async () => {
    const started = startIntake(fresh()).intake;
    const r = await answer(started, "I have a rash on my arms that itches");
    expect(r.intake.pathway).toBe("rash");
  });

  it("records the input mode so text vs voice usage is measurable", async () => {
    const started = startIntake(fresh()).intake;
    const r = await answer(started, "my acne is bad", "voice");
    expect(r.intake.voiceTurns).toBe(1);
    expect(r.intake.textTurns).toBe(0);
  });

  it("completes a whole intake inside the question budget", async () => {
    let intake = startIntake(fresh()).intake;
    const answers = [
      "I've had an itchy rash on both arms for about three months",
      "Both inner elbows, and now my neck",
      "Started around May, and it's got worse",
      "Really itchy, especially at night",
      "Hot showers make it worse",
      "New laundry detergent a few months ago",
      "Just drugstore hydrocortisone, helped a bit at first",
      "I had eczema as a kid",
      "Levothyroxine, allergic to sulfa",
      "I want to sleep through the night",
      "extra answer that should never be needed",
    ];
    let finished = false;
    let turns = 0;
    for (const a of answers) {
      if (finished) break;
      const r = await answer(intake, a);
      intake = r.intake;
      finished = r.finished;
      turns += 1;
    }
    expect(finished).toBe(true);
    expect(turns).toBeLessThanOrEqual(MAX_QUESTIONS);
    expect(intake.questionCount).toBeLessThanOrEqual(MAX_QUESTIONS);
    expect(intake.facts.length).toBeGreaterThanOrEqual(6);
  });

  it("asks in the pathway's clinical order rather than reshuffling it", async () => {
    let intake = startIntake(fresh()).intake;
    const answers = [
      "my acne is breaking out along my jaw",
      "jawline and chin, leaving marks",
      "about a year, getting worse",
      "benzoyl peroxide wash and a clindamycin gel",
      "worse around my period",
      "it really bothers me",
      "no medications, no allergies",
      "I want it to stop scarring",
    ];
    for (const a of answers) {
      const r = await answer(intake, a);
      intake = r.intake;
      if (r.finished) break;
    }
    // Medications/allergies belong late in the conversation, right before the
    // patient's own goal — never ahead of the complaint-specific questions.
    const order = intake.askedSlots;
    expect(order[0]).toBe("concern");
    expect(order.indexOf("acne_distribution")).toBeLessThan(order.indexOf("acne_treatments"));
    expect(order.indexOf("acne_treatments")).toBeLessThan(order.indexOf("context"));
    expect(order[order.length - 1]).toBe("goal");
  });

  it("drops optional questions before it drops the patient's goal", async () => {
    let intake = startIntake(fresh()).intake;
    for (let i = 0; i < MAX_QUESTIONS + 2; i += 1) {
      const r = await answer(intake, "an itchy rash on my arms, it is worse at night");
      intake = r.intake;
      if (r.finished) break;
    }
    expect(intake.askedSlots).toContain("goal");
    expect(intake.askedSlots.length).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it("never asks the same slot twice across a full run", async () => {
    let intake = startIntake(fresh()).intake;
    for (let i = 0; i < MAX_QUESTIONS + 3; i += 1) {
      const r = await answer(intake, `answer number ${i} about my spot on my back`);
      intake = r.intake;
      if (r.finished) break;
    }
    expect(new Set(intake.askedSlots).size).toBe(intake.askedSlots.length);
  });
});

describe("empty and malformed input", () => {
  it("treats an empty answer as a skip and keeps moving", async () => {
    const started = startIntake(fresh()).intake;
    const r = await answer(started, "");
    expect(r.finished).toBe(false);
    expect(r.nextQuestion).toBeTruthy();
    expect(r.intake.facts).toHaveLength(0);
  });

  it("still reaches the end of the interview if the patient skips everything", async () => {
    let intake = startIntake(fresh()).intake;
    let finished = false;
    for (let i = 0; i < MAX_QUESTIONS + 3 && !finished; i += 1) {
      const r = await answer(intake, "");
      intake = r.intake;
      finished = r.finished;
    }
    expect(finished).toBe(true);
    expect(intake.openQuestions.length).toBeGreaterThan(0);
  });

  it("flags urgent language without offering any assessment", async () => {
    const started = startIntake(fresh()).intake;
    const r = await answer(started, "the rash spread and I'm having trouble breathing");
    expect(r.intake.urgentFlag).toBe(true);
  });

  it("carries a question the patient asked through to the physician", async () => {
    const started = startIntake(fresh()).intake;
    const r = await answer(started, "I have a mole on my back. Should this come off?");
    expect(r.intake.patientQuestions.length).toBeGreaterThan(0);
  });
});

describe("structured output validation", () => {
  const at = new Date().toISOString();

  it("rejects a payload that is not an object", () => {
    expect(parseTurn(null, ["concern"], "hi", at)).toBeNull();
    expect(parseTurn("nope", ["concern"], "hi", at)).toBeNull();
    expect(parseTurn({ facts: "not-an-array" }, ["concern"], "hi", at)).toBeNull();
  });

  it("drops facts attributed to a slot that was not asked about", () => {
    const r = parseTurn(
      {
        facts: [
          { slot: "medications", value: "invented", verbatim: "invented", certainty: "stated" },
          { slot: "concern", value: "a rash", verbatim: "a rash", certainty: "stated" },
        ],
        patient_questions: [],
        next_question: "ok",
      },
      ["concern"],
      "a rash",
      at,
    );
    expect(r?.facts).toHaveLength(1);
    expect(r?.facts[0].slot).toBe("concern");
  });

  it("drops facts with an invalid certainty rather than guessing one", () => {
    const r = parseTurn(
      { facts: [{ slot: "concern", value: "x", verbatim: "x", certainty: "very-sure" }], patient_questions: [], next_question: "" },
      ["concern"],
      "x",
      at,
    );
    expect(r?.facts).toHaveLength(0);
  });

  it("replaces a quote the patient never said with their actual answer", () => {
    const r = parseTurn(
      {
        facts: [
          { slot: "concern", value: "rash for 3 months", verbatim: "for exactly three months", certainty: "stated" },
        ],
        patient_questions: [],
        next_question: "",
      },
      ["concern"],
      "I've had a rash a while",
      at,
    );
    expect(r?.facts[0].verbatim).toBe("I've had a rash a while");
  });

  it("keeps a quote that genuinely appears in the answer", () => {
    const r = parseTurn(
      {
        facts: [{ slot: "concern", value: "rash", verbatim: "a rash a while", certainty: "stated" }],
        patient_questions: [],
        next_question: "",
      },
      ["concern"],
      "I've had a rash a while",
      at,
    );
    expect(r?.facts[0].verbatim).toBe("a rash a while");
  });
});

describe("HPI generation without a model", () => {
  it("produces a deterministic HPI and reports that no model was used", async () => {
    const d = seedData();
    const visit = d.visits.get("vis_maya")!;
    const intake = [...d.intakes.values()].find((i) => i.visitId === "vis_maya")!;
    const bundle: IntakeBundle = {
      intake,
      visit,
      patient: d.patients.get("pat_maya")!,
      practice: d.practices.get(visit.practiceId)!,
    };
    const r = await generateHpi(bundle);
    expect(r.usedModel).toBe(false);
    expect(r.intake.hpi.length).toBeGreaterThan(100);
    expect(r.intake.aiUsage.estimatedCostUsd).toBe(0);
  });
});
