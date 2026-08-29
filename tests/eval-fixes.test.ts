import { describe, expect, it } from "vitest";
import { conductTurn, startIntake } from "@/lib/interview/conduct";
import { blankIntake } from "@/lib/demo/seed";
import { detectUrgent, computeOpenQuestions } from "@/lib/interview/engine";
import { harvest } from "@/lib/interview/harvest";
import type { Intake } from "@/lib/domain/types";

/**
 * Regression tests for defects the eval lab surfaced. Each locks in one fix so a
 * future change cannot silently reintroduce it. See evals/ for the harness that
 * found these.
 */

const AT = new Date().toISOString();
const ALL_TREAT = ["treatments", "acne_treatments", "sun_history", "location", "timeline"];

async function drive(opening: string, bySlot: Record<string, string>): Promise<Intake> {
  let intake = startIntake(blankIntake("v")).intake;
  let next = opening;
  for (let t = 0; t < 14; t += 1) {
    const r = await conductTurn({ intake, answer: next, inputMode: "text" });
    intake = r.intake;
    if (r.finished) break;
    next = bySlot[intake.askedSlots[intake.askedSlots.length - 1]] ?? "";
  }
  return intake;
}

describe("treatment over-harvest (eval: acne-unsure-what-used)", () => {
  it("does not harvest a treatment slot from a vague 'the stuff I've tried'", () => {
    const facts = harvest("My acne isn't getting better with the stuff I've tried", ALL_TREAT, AT);
    expect(facts.some((f) => f.slot === "acne_treatments")).toBe(false);
  });

  it("still harvests a named treatment", () => {
    const facts = harvest("I tried hydrocortisone cream and it did nothing", ["treatments"], AT);
    expect(facts.some((f) => f.slot === "treatments")).toBe(true);
  });

  it("does not let a stray 'nothing' in another answer suppress the treatment question", () => {
    const facts = harvest("Short haircut, nothing else and nothing happened before it", ["treatments"], AT);
    expect(facts.some((f) => f.slot === "treatments")).toBe(false);
  });

  it("surfaces an unnameable treatment to clarify once the engine actually asks", async () => {
    const intake = await drive("My acne isn't getting better with what I've used", {
      acne_distribution: "Cheeks and jaw",
      timeline: "A couple of years",
      acne_treatments: "Some cream from the pharmacy, I don't remember which one",
      acne_pattern: "No pattern",
      acne_impact: "It bothers me",
      context: "No medications",
      goal: "Something that works",
    });
    const clarify = computeOpenQuestions(intake);
    expect(clarify.some((c) => c.includes("could not name"))).toBe(true);
  });
});

describe("self-diagnosis not filed as history (eval: lesion-self-diagnosis-melanoma)", () => {
  it("does not harvest 'I know this is melanoma' into sun_history", () => {
    const facts = harvest("I know this is melanoma, it looks like the pictures online", ["sun_history"], AT);
    expect(facts.some((f) => f.slot === "sun_history")).toBe(false);
  });

  it("still harvests genuine sun/cancer history", () => {
    const facts = harvest("My brother had a melanoma removed and I had bad sunburns", ["sun_history"], AT);
    expect(facts.some((f) => f.slot === "sun_history")).toBe(true);
  });
});

describe("self-harm urgent detection (eval: urgent-3)", () => {
  it.each([
    "I've been thinking about hurting myself",
    "I want to harm myself",
    "I feel like I want to end my life",
    "honestly I don't want to be here anymore",
  ])("flags %s", (t) => {
    expect(detectUrgent(t)).toBe(true);
  });

  it("does not flag an ordinary complaint", () => {
    expect(detectUrgent("my rash itches and it is annoying me")).toBe(false);
  });
});

describe("multiple concerns survive a sparse interview (eval: general-multiple-concerns)", () => {
  it("keeps the concerns flag even when the patient answers almost nothing", () => {
    const clarify = computeOpenQuestions({
      pathway: "lesion",
      facts: [],
      askedSlots: ["concern", "location", "lesion_timeline"],
      concernCount: 3,
    });
    expect(clarify.some((c) => c.includes("3 separate concerns"))).toBe(true);
  });
});

describe("vague quantities read as approximate (eval: temporal-a-few-years)", () => {
  it("marks 'a few years' approximate", async () => {
    const intake = await drive("An itchy rash on my arms a few years", {
      location: "Both arms",
      timeline: "Started a few years ago, hard to say",
      symptoms: "Itchy",
    });
    const timeline = intake.facts.find((f) => f.slot === "timeline");
    expect(timeline?.certainty).toBe("approximate");
  });
});

describe("a cancer worry is not a sun/skin-cancer history", () => {
  it.each([
    "I am worried this might be skin cancer, dark spot on my shoulder",
    "Could this be a melanoma? New mole on my leg",
    "I'm scared this is a melanoma",
    "What if it's skin cancer?",
    "Is this melanoma?",
  ])("does not harvest the fear into sun_history: %s", (opening) => {
    expect(harvest(opening, ["sun_history"], AT)).toHaveLength(0);
  });

  it.each([
    "Lots of sunburns as a kid and my father had melanoma",
    "I had a basal cell removed from my nose two years ago",
    "I burn easily and spent every summer at the beach",
    "I used tanning beds all through college",
    "My mother is a melanoma survivor",
  ])("still harvests a real risk history: %s", (opening) => {
    expect(harvest(opening, ["sun_history"], AT)).toHaveLength(1);
  });

  it("asks the sun-history question when the opener only voiced a fear", async () => {
    const intake = await drive("I am worried this might be skin cancer, dark spot on my shoulder", {
      location: "Left shoulder",
      lesion_timeline: "About four months, looks bigger",
      lesion_symptoms: "No itch or bleeding",
      sun_history: "Bad sunburns as a teenager, my aunt had a melanoma removed",
      lesion_others: "No",
      treatments: "Nothing",
      context: "No medications",
      goal: "Want to know if it needs removing",
    });
    expect(intake.askedSlots).toContain("sun_history");
    const sun = intake.facts.find((f) => f.slot === "sun_history");
    expect(sun?.value.toLowerCase()).toContain("sunburns");
    expect(sun?.value.toLowerCase()).not.toContain("worried");
  });
});
