import { describe, expect, it } from "vitest";
import { clauses, countConcerns, harvest } from "@/lib/interview/harvest";

const AT = new Date().toISOString();
const ALL = [
  "location", "timeline", "symptoms", "triggers", "exposures", "treatments",
  "atopy", "context", "goal", "lesion_timeline", "lesion_symptoms", "sun_history",
  "acne_distribution", "acne_treatments", "acne_pattern", "hair_pattern", "hair_care",
];

const bySlot = (text: string, slots = ALL) =>
  Object.fromEntries(harvest(text, slots, AT).map((f) => [f.slot, f]));

/**
 * Harvesting is the mechanism that lets a patient who explains everything up
 * front answer three questions instead of nine. Its failure mode matters: a
 * missed signal costs one question, a wrong claim silently drops a question the
 * dermatologist needed. These tests hold that line.
 */
describe("harvesting an opening answer", () => {
  const DUMP =
    "I've had this itchy red scaly rash on both elbows and knees for maybe 4 months, I tried hydrocortisone 1% which did nothing, my dad has eczema, and I take metformin";

  it("reads location, timing, symptoms, treatment and medications from one answer", () => {
    const got = bySlot(DUMP);
    expect(Object.keys(got).sort()).toEqual(
      expect.arrayContaining(["location", "timeline", "symptoms", "treatments", "context"]),
    );
  });

  it("stores only the words that answer each slot", () => {
    const got = bySlot(DUMP);
    expect(got.location.value.toLowerCase()).toContain("elbows");
    expect(got.location.value.toLowerCase()).not.toContain("hydrocortisone");
    expect(got.timeline.value.toLowerCase()).toContain("4 months");
    expect(got.timeline.value.toLowerCase()).not.toContain("knees");
    expect(got.symptoms.value.toLowerCase()).toContain("itchy");
  });

  it("marks everything it takes as harvested, so provenance stays honest", () => {
    for (const f of Object.values(bySlot(DUMP))) {
      expect(f.harvested).toBe(true);
      expect(f.source).toBe("patient");
    }
  });

  it("stores the patient's own words, never a paraphrase", () => {
    const got = bySlot(DUMP);
    for (const f of Object.values(got)) {
      const words = f.verbatim.toLowerCase().split(/[^a-z0-9%]+/).filter((w) => w.length > 3);
      for (const w of words) expect(DUMP.toLowerCase()).toContain(w);
    }
  });

  it("marks a duration with no sense of direction as partial", () => {
    expect(bySlot("A rash on my arms for about three weeks").timeline?.partial).toBe(true);
  });

  it("does not mark a duration as partial when progression is given too", () => {
    const got = bySlot("A rash on my arms for about three weeks and it is getting worse");
    expect(got.timeline?.partial).toBe(false);
  });

  it("marks a treatment with no response as partial", () => {
    expect(bySlot("Rash on my arms, I tried hydrocortisone cream for it").treatments?.partial).toBe(true);
  });

  it("does not mark a treatment as partial when the response is given", () => {
    const got = bySlot("Rash on my arms, I tried hydrocortisone cream and it did nothing");
    expect(got.treatments?.partial).toBe(false);
  });

  it("takes nothing from a short answer, where a match would be a guess", () => {
    expect(harvest("my arm", ALL, AT)).toEqual([]);
    expect(harvest("itchy", ALL, AT)).toEqual([]);
  });

  it("never claims a slot the pathway is not asking about", () => {
    const got = harvest(DUMP, ["goal"], AT);
    expect(got.every((f) => f.slot === "goal")).toBe(true);
  });

  it("never claims the same slot twice", () => {
    const slots = harvest(DUMP, ALL, AT).map((f) => f.slot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("bounds what it stores", () => {
    const huge = `An itchy rash on my elbows ${"and it spreads everywhere ".repeat(200)}`;
    for (const f of harvest(huge, ALL, AT)) {
      expect(f.value.length).toBeLessThanOrEqual(220);
    }
  });

  it("carries the patient's hedge into the certainty rating", () => {
    expect(bySlot("An itchy rash on my arms for maybe three months").timeline?.certainty).toBe("approximate");
  });

  it("reads an allergy as relevant context", () => {
    const got = bySlot("I have a rash on my chest and I'm allergic to penicillin");
    expect(got.context?.value.toLowerCase()).toContain("allergic to penicillin");
  });

  it("reads sun history for a lesion visit", () => {
    const got = bySlot("A spot on my nose, I worked outdoors for twenty years with a lot of sunburns");
    expect(got.sun_history?.value.toLowerCase()).toMatch(/outdoor|sunburn/);
  });

  it("reads hair care for a hair visit", () => {
    const got = bySlot("My edges are thinning, I wear braids and I relax my hair");
    expect(got.hair_care?.value.toLowerCase()).toMatch(/braid|relax/);
  });
});

describe("clause splitting", () => {
  it("splits on sentence ends and on list commas", () => {
    const out = clauses("It itches a lot. I tried a cream, and it did nothing");
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("does not split a body-site list into fragments", () => {
    const out = clauses("It is on my elbows, knees and neck");
    expect(out[0]).toContain("elbows");
    expect(out[0]).toContain("knees");
  });
});

describe("counting concerns", () => {
  it("recognises an explicitly enumerated set", () => {
    expect(countConcerns("I have three things I want looked at")).toBe(3);
    expect(countConcerns("There are a couple of issues")).toBe(2);
  });

  it("recognises three distinct body sites raised together", () => {
    expect(
      countConcerns("a spot on my nose, dry itchy skin on my legs, and my nails are splitting"),
    ).toBeGreaterThanOrEqual(3);
  });

  it("reports one for an ordinary single complaint", () => {
    expect(countConcerns("I've had an itchy rash on both arms for three months")).toBe(1);
    expect(countConcerns("A mole on my back has changed")).toBe(1);
  });
});
