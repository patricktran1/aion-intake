import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./fixtures/scenarios";
import { blankIntake } from "@/lib/demo/seed";
import { conductTurn, startIntake } from "@/lib/interview/conduct";
import { buildBrief, composeHpiDeterministic, headline } from "@/lib/ai/compose";
import { guardAll } from "@/lib/ai/guard";
import { MAX_QUESTIONS } from "@/lib/interview/slots";
import type { Intake, IntakeBundle } from "@/lib/domain/types";

/**
 * The whole scenario library, run through the real engine.
 *
 * These are the properties that have to hold for every complaint, not just the
 * ones that were convenient to hand-write a test for: routing, question
 * economy, no repetition, no drift, and a guard-clean brief at the end.
 */

const bundleFor = (intake: Intake): IntakeBundle => ({
  intake,
  visit: { id: "v", practiceId: "p", patientId: "pt", scheduledFor: new Date().toISOString(), reasonBooked: "D", location: "L" },
  patient: { id: "pt", firstName: "Sim", lastName: "Patient", dateOfBirth: "1985-06-15" },
  practice: { id: "p", name: "P", clinicianName: "Dr. S", clinicianCredential: "MD" },
});

async function runScenario(s: (typeof SCENARIOS)[number]) {
  let intake = startIntake(blankIntake("v")).intake;
  let next = s.opening;
  for (let i = 0; i < 20; i += 1) {
    const r = await conductTurn({ intake, answer: next, inputMode: "text" });
    intake = r.intake;
    if (r.finished) break;
    const slot = intake.askedSlots[intake.askedSlots.length - 1];
    next = s.answerFor[slot] ?? s.fallback ?? "not sure";
  }
  return intake;
}

const cache = new Map<string, Promise<Intake>>();
const get = (s: (typeof SCENARIOS)[number]) => {
  if (!cache.has(s.id)) cache.set(s.id, runScenario(s));
  return cache.get(s.id)!;
};

describe.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
  it(`routes to the ${scenario.expectPathway} pathway`, async () => {
    expect((await get(scenario)).pathway).toBe(scenario.expectPathway);
  });

  it("stays within the question budget", async () => {
    expect((await get(scenario)).questionCount).toBeLessThanOrEqual(MAX_QUESTIONS);
  });

  it("never asks the same thing twice", async () => {
    const asked = (await get(scenario)).askedSlots;
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("does not drift to another pathway's questions", async () => {
    const intake = await get(scenario);
    const { PATHWAY_SLOTS } = await import("@/lib/interview/slots");
    const own = new Set([...PATHWAY_SLOTS[intake.pathway].map((s) => s.id), "concern"]);
    for (const slot of intake.askedSlots) expect(own.has(slot)).toBe(true);
  });

  it("produces a guard-clean brief and HPI", async () => {
    const intake = await get(scenario);
    const hpi = composeHpiDeterministic(bundleFor(intake));
    const sources = intake.facts.flatMap((f) => [f.verbatim, f.value]);
    expect(guardAll(hpi, sources)).toEqual([]);
  });

  it("produces a headline that reads as a whole thought", async () => {
    const h = headline(await get(scenario));
    expect(h.length).toBeGreaterThan(3);
    expect(h.length).toBeLessThanOrEqual(200);
    expect(h.trim()).not.toMatch(/\b(and|the|a|of|for|with|on|in)$/i);
  });

  it("keeps clarify-in-visit short enough to actually read", async () => {
    const intake = await get(scenario);
    expect(intake.openQuestions.length).toBeLessThanOrEqual(4);
  });

  it("never renders an empty or non-answer row in the brief", async () => {
    const brief = buildBrief(await get(scenario));
    for (const section of brief) {
      for (const item of section.items) {
        expect(item.text.trim().length).toBeGreaterThan(0);
        expect(item.text.toLowerCase()).not.toMatch(/^(not sure|idk|dunno|no idea)$/);
      }
    }
  });

  it("gives every brief row a distinct heading", async () => {
    const brief = buildBrief(await get(scenario));
    const labels = brief.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("interview economy across the whole scenario library", () => {
  it("averages well under the question budget", async () => {
    const counts = await Promise.all(SCENARIOS.map(async (s) => (await get(s)).questionCount));
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(mean).toBeLessThan(MAX_QUESTIONS);
    expect(mean).toBeGreaterThan(3);
  });

  it("asks a patient who explained everything up front far fewer questions", async () => {
    const dump = await get(SCENARIOS.find((s) => s.id === "rash-info-dump")!);
    const plain = await get(SCENARIOS.find((s) => s.id === "rash-multi-treatment")!);
    expect(dump.questionCount).toBeLessThan(plain.questionCount);
  });

  it("stops early on a patient who has stopped answering", async () => {
    const vague = await get(SCENARIOS.find((s) => s.id === "rash-vague")!);
    expect(vague.questionCount).toBeLessThanOrEqual(4);
  });

  it("keeps clarify noise low on average", async () => {
    const totals = await Promise.all(SCENARIOS.map(async (s) => (await get(s)).openQuestions.length));
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    expect(mean).toBeLessThan(2);
  });
});
