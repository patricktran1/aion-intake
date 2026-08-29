import { describe, expect, it } from "vitest";
import { conductTurn, isGroundedRestatement, parseTurn, startIntake } from "@/lib/interview/conduct";
import { blankIntake } from "@/lib/demo/seed";
import { acceptOrFallbackHpi, buildBrief, composeHpiDeterministic, headline } from "@/lib/ai/compose";
import { guardAll } from "@/lib/ai/guard";
import type { Intake, IntakeBundle } from "@/lib/domain/types";

/**
 * Fidelity is the property the whole product rests on: a dermatologist has to
 * be able to trust that every clinical claim in the brief and the HPI came from
 * the patient. These tests are the adversarial half of that — each one is a
 * real way a summary could quietly promote a weak claim into a fact.
 */

const bundle = (intake: Intake): IntakeBundle => ({
  intake,
  visit: {
    id: "v",
    practiceId: "p",
    patientId: "pt",
    scheduledFor: new Date().toISOString(),
    reasonBooked: "Derm",
    location: "L",
  },
  patient: { id: "pt", firstName: "Test", lastName: "Patient", dateOfBirth: "1980-01-01" },
  practice: { id: "p", name: "P", clinicianName: "Dr. T", clinicianCredential: "MD" },
});

/**
 * Drives a full intake and returns the artefacts.
 *
 * Answers may be positional (the patient types whatever comes next) or keyed by
 * slot. Keyed is the honest form for tests that care about a specific slot,
 * because harvesting changes which question comes next — which is the whole
 * point of it.
 */
async function intakeFrom(answers: string[], bySlot: Record<string, string> = {}) {
  let intake = startIntake(blankIntake("v")).intake;
  let i = 0;
  for (let turn = 0; turn < 14; turn += 1) {
    const asked = intake.askedSlots[intake.askedSlots.length - 1];
    const keyed = bySlot[asked];
    const answer = keyed ?? answers[i++] ?? "";
    if (keyed === undefined && i > answers.length) break;
    const r = await conductTurn({ intake, answer, inputMode: "text" });
    intake = r.intake;
    if (r.finished) break;
  }
  const b = bundle(intake);
  return { intake, hpi: composeHpiDeterministic(b), brief: buildBrief(intake), bundle: b };
}

describe("uncertain dates are never sharpened", () => {
  it("keeps an approximate month approximate", async () => {
    const { hpi } = await intakeFrom(["I have an itchy rash on my arms"], {
      location: "Both forearms",
      timeline: "I think it started around May",
    });
    expect(hpi).not.toMatch(/May \d/);
    expect(hpi).toMatch(/approximation|around May/i);
  });

  it("never converts 'a while' into a duration", async () => {
    const { hpi } = await intakeFrom(["There's a spot on my cheek"], {
      location: "Left cheek",
      lesion_timeline: "I've had it a while, I really don't know how long",
    });
    expect(hpi).not.toMatch(/\b\d+\s*(month|year|week)/i);
  });

  it("keeps two separate timelines separate rather than merging them", async () => {
    const { hpi } = await intakeFrom(["My scalp is itchy and flaky and now I'm losing hair where it's worst"], {
      hair_pattern: "Mostly the crown",
      timeline: "The itching started a year ago, the hair loss maybe four months",
    });
    expect(hpi).toContain("itching started a year ago");
    expect(hpi).toContain("four months");
  });
});

describe("self-diagnosis stays the patient's, not ours", () => {
  it("attributes a condition the patient named to the patient", async () => {
    const { hpi } = await intakeFrom([
      "I think this is eczema, it looks like what I had as a kid",
      "Inner elbows",
      "About a month",
    ]);
    expect(hpi).not.toMatch(/^Patient has eczema/m);
    expect(hpi).toMatch(/I think this is eczema/);
  });

  it("keeps a second-hand tentative diagnosis tentative", async () => {
    const { hpi } = await intakeFrom([
      "My doctor said it might be psoriasis but she wasn't sure",
      "Scalp and behind my ears",
      "Six months",
    ]);
    expect(hpi).toMatch(/might be psoriasis/);
    expect(hpi).not.toMatch(/\bhas psoriasis\b/);
    expect(hpi).not.toMatch(/diagnos(is|ed) of psoriasis/i);
  });

  it("does not introduce a diagnosis the patient never used", async () => {
    const { hpi, intake } = await intakeFrom([
      "Round smooth bald patches appeared on the back of my head",
      "Two patches at the back",
      "Three weeks",
      "Scalp looks normal, not itchy",
    ]);
    const sources = intake.facts.flatMap((f) => [f.verbatim, f.value]);
    expect(guardAll(hpi, sources)).toEqual([]);
    expect(hpi.toLowerCase()).not.toContain("alopecia areata");
  });
});

describe("negatives", () => {
  it("records a negative the patient actually stated", async () => {
    const { hpi } = await intakeFrom([
      "A dry patch on the back of my hand",
      "Back of my right hand",
      "Three months",
      "It doesn't itch and it doesn't hurt",
    ]);
    expect(hpi).toMatch(/doesn't itch/);
  });

  it("never writes a negative the patient did not state", async () => {
    const { hpi, intake } = await intakeFrom([
      "A dry patch on my hand",
      "Right hand",
      "Three months",
    ]);
    const sources = intake.facts.flatMap((f) => [f.verbatim, f.value]);
    expect(guardAll(hpi, sources)).toEqual([]);
    expect(hpi.toLowerCase()).not.toContain("denies");
    expect(hpi.toLowerCase()).not.toContain("no known drug allergies");
  });

  it("does not turn 'I don't think anything makes it worse' into a clinical denial", async () => {
    const { hpi } = await intakeFrom([
      "A dry patch on my hand",
      "Right hand",
      "Three months",
      "It doesn't itch",
      "I don't think anything makes it worse",
    ]);
    expect(hpi).not.toMatch(/denies (?:exacerbating|aggravating)/i);
  });

  it("separates 'not asked' from 'answered no'", async () => {
    const { hpi } = await intakeFrom(["I have a rash on my arms", "Both arms", ""]);
    // The sections we never got to are named, not silently absent.
    expect(hpi).toContain("Not established during intake:");
    // And nothing in the body asserts them.
    const body = hpi.split("Not established during intake:")[0];
    expect(body).not.toMatch(/no (?:medications|allergies)/i);
  });
});

describe("ambiguous treatments", () => {
  it("keeps an unnameable treatment unnamed rather than guessing", async () => {
    const { hpi } = await intakeFrom(["I have a rash on my chest"], {
      location: "Chest and stomach",
      timeline: "Two months",
      symptoms: "Itchy",
      triggers: "Nothing sets it off",
      exposures: "Nothing new",
      treatments: "A cream my doctor gave me, I don't remember which one",
    });
    expect(hpi).toMatch(/don't remember which one/);
    expect(hpi).not.toMatch(/hydrocortisone|triamcinolone|clobetasol/i);
  });

  it("flags an unnameable treatment for the visit", async () => {
    const { intake } = await intakeFrom(["I have a rash on my chest"], {
      location: "Chest and stomach",
      timeline: "Two months, about the same",
      symptoms: "Itchy",
      triggers: "Nothing sets it off",
      exposures: "Nothing new",
      treatments: "A cream my doctor gave me, I don't remember which one",
      atopy: "No family history",
      context: "No medications",
      goal: "Make it go away",
    });
    expect(intake.openQuestions.some((q) => q.includes("could not name"))).toBe(true);
  });

  it("does not claim a treatment failed when the patient stopped for another reason", async () => {
    const { hpi } = await intakeFrom(["My hairline is receding"], {
      hair_pattern: "Temples and the top",
      timeline: "Five years, gradual",
      hair_scalp: "Scalp is normal",
      hair_stressors: "Nothing happened before it started",
      hair_care: "Short haircut, nothing else",
      treatments: "I tried minoxidil for two months but it was messy so I stopped",
    });
    expect(hpi).toMatch(/messy so I stopped/);
    expect(hpi).not.toMatch(/failed|ineffective|did not respond/i);
  });
});

describe("contradictions and messy input", () => {
  it("records a self-correction rather than silently choosing one version", async () => {
    const { intake } = await intakeFrom(["I have a rash that has been there for two weeks"], {
      location: "My back",
      timeline: "Actually it's been about six months now that I think about it",
    });
    const all = intake.facts.map((f) => f.verbatim).join(" ");
    expect(all).toContain("two weeks");
    expect(all).toContain("six months");
  });

  it("survives an emoji-heavy answer without mangling it", async () => {
    const { hpi, brief } = await intakeFrom([
      "my skin is so dry 😭😭 its flaking everywhere 🥲 pls help",
      "legs and arms 🙃",
      "since winter started",
    ]);
    expect(hpi).toContain("flaking everywhere");
    expect(brief.length).toBeGreaterThan(1);
  });

  it("bounds a pathologically long answer everywhere it renders", async () => {
    const huge = `My back and shoulders ${"and it spreads a lot ".repeat(400)}`;
    const { hpi, brief } = await intakeFrom(["I have a rash"], { location: huge });
    for (const section of brief) {
      for (const item of section.items) {
        expect(item.text.length).toBeLessThanOrEqual(400);
      }
    }
    expect(hpi.length).toBeLessThan(6000);
  });

  it("handles a spelling-mangled answer without inventing a correction", async () => {
    const { hpi } = await intakeFrom(["i hav a rash on my arm"], {
      location: "rite forearm",
      timeline: "abowt 3 weaks",
    });
    // Sentence-casing is the only change permitted; the words stay the patient's.
    expect(hpi.toLowerCase()).toContain("rite forearm");
    expect(hpi.toLowerCase()).toContain("abowt 3 weaks");
  });
});

describe("guard holds across every generated artefact", () => {
  const CASES: string[][] = [
    ["I have an itchy rash on both arms", "Both forearms", "About three weeks", "Very itchy"],
    ["A mole on my back changed colour", "Upper back", "Six months", "It bled once"],
    ["Cystic acne along my jaw", "Jaw and chin, some scarring", "Three years", "Clindamycin, helped a bit"],
    ["My hair is shedding badly", "All over", "Four months", "Scalp normal"],
    ["My toenails are thick and yellow", "Both big toes", "Two years", "No pain"],
    ["something is wrong with my skin i cant describe it", "everywhere", "months", "it feels wrong"],
  ];

  it.each(CASES)("produces a guard-clean HPI for: %s", async (...answers) => {
    const { hpi, intake } = await intakeFrom(answers);
    const sources = intake.facts.flatMap((f) => [f.verbatim, f.value]);
    expect(guardAll(hpi, sources)).toEqual([]);
  });

  it.each(CASES)("produces a headline that is never clipped for: %s", async (...answers) => {
    const { intake } = await intakeFrom(answers);
    expect(headline(intake)).not.toContain("…");
  });
});

describe("model output is held to the same standard", () => {
  it("rejects a fluent draft that promotes a hedge into a date", async () => {
    const { bundle: b } = await intakeFrom([
      "Itchy rash on my arms",
      "Both forearms",
      "I think it started around May",
    ]);
    const bad =
      "The patient is a 45-year-old with an itchy eruption of both forearms that began on May 1 and has persisted since.";
    expect(acceptOrFallbackHpi(bad, b).accepted).toBe(false);
  });

  it("rejects a draft that adds an examination finding", async () => {
    const { bundle: b } = await intakeFrom(["Itchy rash on my arms", "Both forearms", "Three weeks"]);
    const bad =
      "Patient reports an itchy rash of both forearms for three weeks. On examination there are erythematous scaly plaques with excoriation.";
    expect(acceptOrFallbackHpi(bad, b).accepted).toBe(false);
  });

  it("rejects a draft that adds a diagnosis the patient never used", async () => {
    const { bundle: b } = await intakeFrom(["Itchy rash on my arms", "Both forearms", "Three weeks"]);
    const bad =
      "Patient reports an itchy rash affecting both forearms for approximately three weeks, with a presentation typical of atopic eczema in an adult.";
    expect(acceptOrFallbackHpi(bad, b).accepted).toBe(false);
  });

  it("accepts a faithful draft", async () => {
    const { bundle: b } = await intakeFrom(["Itchy rash on my arms", "Both forearms", "Three weeks"]);
    const good =
      "Patient reports an itchy rash affecting both forearms, present for about three weeks. They describe the location as both forearms and the duration as three weeks.";
    expect(acceptOrFallbackHpi(good, b).accepted).toBe(true);
  });
});

describe("the model's restatement is grounded, not just its quote", () => {
  const at = new Date().toISOString();

  it("accepts a restatement built from the patient's own words", () => {
    expect(
      isGroundedRestatement("Itchy rash on both arms", "I have an itchy rash on both my arms"),
    ).toBe(true);
  });

  it("accepts a rearrangement that adds only connective words", () => {
    expect(
      isGroundedRestatement(
        "Started on the elbows, now also the neck",
        "it started on my elbows and now it's on my neck too",
      ),
    ).toBe(true);
  });

  it("rejects a duration the patient never gave", () => {
    expect(isGroundedRestatement("Rash for three months", "I've had a rash a while")).toBe(false);
  });

  it("rejects a body site the patient never named", () => {
    expect(
      isGroundedRestatement("Rash on the trunk and thighs", "I have a rash on my arms"),
    ).toBe(false);
  });

  it("rejects a drug name the patient never used", () => {
    expect(
      isGroundedRestatement("Tried triamcinolone ointment", "I used some cream from the chemist"),
    ).toBe(false);
  });

  it("falls back to the patient's words when the restatement is not grounded", () => {
    const parsed = parseTurn(
      {
        facts: [
          {
            slot: "timeline",
            value: "Symptoms began three months ago",
            verbatim: "a while",
            certainty: "stated",
          },
        ],
        patient_questions: [],
        next_question: "",
      },
      ["timeline"],
      "I've had it a while",
      at,
    );
    expect(parsed?.facts[0].value.toLowerCase()).toContain("a while");
    expect(parsed?.facts[0].value).not.toContain("three months");
  });

  it("keeps a grounded restatement as the model wrote it", () => {
    const parsed = parseTurn(
      {
        facts: [
          {
            slot: "location",
            value: "Both forearms and the neck",
            verbatim: "both forearms",
            certainty: "stated",
          },
        ],
        patient_questions: [],
        next_question: "",
      },
      ["location"],
      "it's on both forearms and my neck",
      at,
    );
    expect(parsed?.facts[0].value).toBe("Both forearms and the neck");
  });

  it("discards a patient question the model composed rather than quoted", () => {
    const parsed = parseTurn(
      {
        facts: [{ slot: "goal", value: "Wants it gone", verbatim: "want it gone", certainty: "stated" }],
        patient_questions: ["Could this be skin cancer?"],
        next_question: "",
      },
      ["goal"],
      "I just want it gone",
      at,
    );
    expect(parsed?.patientQuestions).toEqual([]);
  });

  it("keeps a patient question the patient actually asked", () => {
    const parsed = parseTurn(
      {
        facts: [{ slot: "goal", value: "Wants to know if it will scar", verbatim: "will it scar", certainty: "stated" }],
        patient_questions: ["Will it scar?"],
        next_question: "",
      },
      ["goal"],
      "mostly I want to know, will it scar?",
      at,
    );
    expect(parsed?.patientQuestions).toEqual(["Will it scar?"]);
  });
});
