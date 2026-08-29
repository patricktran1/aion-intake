import { beforeEach, describe, expect, it } from "vitest";
import { bundleByToken, getIntakeByToken, listBundles, resetDb, saveIntake } from "@/lib/store";
import { DEMO_TOKENS } from "@/lib/demo/seed";
import { resetAnalytics, summarize, track, allEvents } from "@/lib/analytics";

beforeEach(() => {
  resetDb();
  resetAnalytics();
});

describe("demo seed", () => {
  it("provides three completed intakes across different complaint families", () => {
    const ready = listBundles().filter((b) => b.intake.status === "ready_for_review");
    expect(ready).toHaveLength(3);
    expect(new Set(ready.map((b) => b.intake.pathway))).toEqual(
      new Set(["rash", "lesion", "hair_loss"]),
    );
  });

  it("provides open intake links so the patient flow can be walked", () => {
    expect(getIntakeByToken(DEMO_TOKENS.acne)?.status).toBe("not_started");
    expect(getIntakeByToken(DEMO_TOKENS.open)?.status).toBe("not_started");
  });

  it("puts completed briefs at the top of the clinician list", () => {
    expect(listBundles()[0].intake.status).toBe("ready_for_review");
  });

  it("resets back to the seeded state", () => {
    const intake = getIntakeByToken(DEMO_TOKENS.acne)!;
    saveIntake({ ...intake, status: "ready_for_review" });
    expect(getIntakeByToken(DEMO_TOKENS.acne)?.status).toBe("ready_for_review");
    resetDb();
    expect(getIntakeByToken(DEMO_TOKENS.acne)?.status).toBe("not_started");
  });

  it("resolves a full bundle from a patient link", () => {
    const b = bundleByToken(DEMO_TOKENS.acne);
    expect(b?.patient.firstName).toBe("Daniel");
    expect(b?.practice.name).toBe("Lakeview Dermatology");
  });

  it("returns nothing for an unknown link", () => {
    expect(bundleByToken("not-a-real-token")).toBeNull();
  });

  it("contains no real-looking contact details anywhere", () => {
    const blob = JSON.stringify([...listBundles()]);
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/); // SSN shape
    expect(blob).not.toMatch(/@(gmail|yahoo|outlook|hotmail)\./i);
  });
});

describe("analytics", () => {
  it("drops free-text properties so health information cannot leak into logs", () => {
    track("intake_submitted", {
      intake_id: "int_1",
      answer_text: "I have a rash on my arms",
      patient_name: "Maya Ellison",
      question_count: 9,
    });
    const props = allEvents()[0].props;
    expect(props.intake_id).toBe("int_1");
    expect(props.question_count).toBe(9);
    expect(props.answer_text).toBeUndefined();
    expect(props.patient_name).toBeUndefined();
  });

  it("computes the funnel numbers that decide whether the wedge is real", () => {
    track("intake_started", { intake_id: "a" });
    track("intake_started", { intake_id: "b" });
    track("intake_submitted", { intake_id: "a", duration_seconds: 220, question_count: 9, ai_cost_usd: 0 });
    const s = summarize();
    expect(s.intakes_started).toBe(2);
    expect(s.intakes_completed).toBe(1);
    expect(s.completion_rate).toBe(0.5);
    expect(s.median_completion_seconds).toBe(220);
  });

  it("reports zero cost when the deterministic engine did the work", () => {
    track("intake_submitted", { intake_id: "a", ai_cost_usd: 0 });
    expect(summarize().mean_ai_cost_per_completed_intake_usd).toBe(0);
  });
});
