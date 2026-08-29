import { describe, expect, it } from "vitest";
import {
  acceptOrFallbackHpi,
  ageFrom,
  buildBrief,
  composeHpiDeterministic,
  composeNote,
  headline,
  headlineTimeline,
  notEstablished,
} from "@/lib/ai/compose";
import { guardAll } from "@/lib/ai/guard";
import { seedData } from "@/lib/demo/seed";
import type { IntakeBundle } from "@/lib/domain/types";

function bundleFor(patientId: string): IntakeBundle {
  const d = seedData();
  const visit = [...d.visits.values()].find((v) => v.patientId === patientId)!;
  const intake = [...d.intakes.values()].find((i) => i.visitId === visit.id)!;
  return {
    intake,
    visit,
    patient: d.patients.get(patientId)!,
    practice: d.practices.get(visit.practiceId)!,
  };
}

describe("pre-visit brief", () => {
  it("omits sections with nothing in them rather than padding them", () => {
    const b = bundleFor("pat_maya");
    const sections = buildBrief(b.intake);
    expect(sections.length).toBeGreaterThan(4);
    expect(sections.every((s) => s.items.length > 0)).toBe(true);
  });

  it("gives a headline a dermatologist can read in one glance", () => {
    const h = headline(bundleFor("pat_robert").intake);
    expect(h.length).toBeLessThan(180);
    expect(h.toLowerCase()).toContain("spot");
  });

  it("never ends a headline in a clipped word", () => {
    for (const id of ["pat_maya", "pat_robert", "pat_priya"]) {
      const h = headline(bundleFor(id).intake);
      expect(h, `${id} headline must not be truncated`).not.toContain("…");
    }
  });

  it("does not repeat a duration the concern already carries", () => {
    const h = headline(bundleFor("pat_maya").intake);
    expect(h.match(/month/gi)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("keeps a short timeline clause whole rather than clipping it", () => {
    expect(headlineTimeline("Started three weeks ago, slowly worse")).toBe(
      "Started three weeks ago, slowly worse",
    );
  });

  it("falls back to just the duration when the timeline is too long for a headline", () => {
    const long =
      "Present for years but reported by his wife as darker and larger than before and he cannot see it himself at all";
    expect(headlineTimeline(long)).toBe("for years");
  });
});

describe("deterministic draft HPI", () => {
  it("survives its own hallucination guard for every demo patient", () => {
    for (const id of ["pat_maya", "pat_robert", "pat_priya"]) {
      const b = bundleFor(id);
      const hpi = composeHpiDeterministic(b);
      const sources = b.intake.facts.flatMap((f) => [f.verbatim, f.value]);
      expect(guardAll(hpi, sources), `${id} HPI must invent nothing`).toEqual([]);
    }
  });

  it("never invents a negative", () => {
    const hpi = composeHpiDeterministic(bundleFor("pat_maya"));
    expect(hpi.toLowerCase()).not.toContain("denies");
    expect(hpi.toLowerCase()).not.toContain("no history of");
  });

  it("preserves the patient's hedge instead of sharpening it", () => {
    const hpi = composeHpiDeterministic(bundleFor("pat_maya"));
    expect(hpi).toContain("approximation");
    expect(hpi).not.toMatch(/May \d/);
  });

  it("marks the patient's uncertainty rather than dropping it", () => {
    const hpi = composeHpiDeterministic(bundleFor("pat_priya"));
    expect(hpi).toContain("patient unsure");
  });

  it("never states content for a slot that was never filled", () => {
    const b = bundleFor("pat_maya");
    const stripped = { ...b, intake: { ...b.intake, facts: b.intake.facts.slice(0, 1) } };
    const hpi = composeHpiDeterministic(stripped);
    const body = hpi.split("Not established during intake:")[0];
    expect(body).not.toMatch(/^Tried so far:/m);
    expect(body).not.toMatch(/^Medications, allergies, history:/m);
  });

  it("names what the intake did not establish, so absence is not read as a negative", () => {
    const b = bundleFor("pat_maya");
    const stripped = { ...b, intake: { ...b.intake, facts: b.intake.facts.slice(0, 2) } };
    const hpi = composeHpiDeterministic(stripped);
    expect(hpi).toContain("Not established during intake:");
    expect(hpi).toContain("Tried so far");
  });

  it("omits the not-established line when the intake covered everything", () => {
    const hpi = composeHpiDeterministic(bundleFor("pat_robert"));
    expect(hpi).not.toContain("Not established during intake:");
  });

  it("quotes the patient's own words for the presenting concern", () => {
    const hpi = composeHpiDeterministic(bundleFor("pat_robert"));
    expect(hpi).toContain("my wife says has changed");
  });
});

describe("model HPI acceptance", () => {
  const b = bundleFor("pat_maya");

  it("rejects a fluent but fabricated draft and falls back", () => {
    const bad =
      "The patient is a 34-year-old woman with a three month history of pruritic dermatitis. On examination there are erythematous plaques. She denies fever. Assessment: atopic dermatitis.";
    const r = acceptOrFallbackHpi(bad, b);
    expect(r.accepted).toBe(false);
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.text).toBe(composeHpiDeterministic(b));
  });

  it("rejects a suspiciously short draft", () => {
    expect(acceptOrFallbackHpi("Rash.", b).accepted).toBe(false);
  });

  it("accepts a faithful draft", () => {
    const good =
      "Patient reports an itchy rash affecting both arms for about three months, which she describes as \"driving me crazy at night\". It started on the insides of both elbows and now also involves her neck and some of her hands. She states hot showers make it much worse, and thick moisturiser helps for maybe an hour.";
    expect(acceptOrFallbackHpi(good, b).accepted).toBe(true);
  });
});

describe("what the intake did not establish", () => {
  it("names only sections with no answer at all", () => {
    const b = bundleFor("pat_maya");
    expect(notEstablished(b.intake)).toEqual(["New exposures"]);
  });

  it("returns nothing when every section was covered", () => {
    expect(notEstablished(bundleFor("pat_robert").intake)).toEqual([]);
  });

  it("never names the primary concern, which is always present", () => {
    const b = bundleFor("pat_maya");
    const stripped = { ...b.intake, facts: [] };
    expect(notEstablished(stripped)).not.toContain("Primary concern");
  });
});

describe("draft note", () => {
  it("keeps patient-supplied history and clinician findings in separate labelled blocks", () => {
    const b = bundleFor("pat_maya");
    const withReview = {
      ...b,
      intake: {
        ...b.intake,
        hpi: composeHpiDeterministic(b),
        review: {
          exam: "Flexural plaques, both antecubital fossae.",
          assessment: "Atopic dermatitis flare.",
          plan: "Topical steroid, emollient education.",
          medications: "Triamcinolone 0.1% ointment BID x 2 weeks",
          followUp: "6 weeks",
        },
      },
    };
    const note = composeNote(withReview);
    expect(note).toContain("HISTORY OF PRESENT ILLNESS (patient-supplied");
    expect(note).toContain("EXAMINATION (clinician-entered)");
    expect(note).toContain("ASSESSMENT (clinician-entered)");
    expect(note).toContain("PLAN (clinician-entered)");
    expect(note.indexOf("HISTORY OF PRESENT ILLNESS")).toBeLessThan(note.indexOf("EXAMINATION"));
  });

  it("states plainly that medications are not transmitted anywhere", () => {
    const b = bundleFor("pat_maya");
    const note = composeNote({
      ...b,
      intake: { ...b.intake, review: { ...b.intake.review, medications: "Triamcinolone" } },
    });
    expect(note).toContain("Not transmitted to any pharmacy");
  });

  it("omits clinician sections that have not been filled in", () => {
    const note = composeNote(bundleFor("pat_maya"));
    expect(note).not.toContain("EXAMINATION");
    expect(note).not.toContain("ASSESSMENT");
  });
});

describe("age", () => {
  it("returns null for an unparseable date of birth", () => {
    expect(ageFrom("not-a-date")).toBeNull();
  });
});
