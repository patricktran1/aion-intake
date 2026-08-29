import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conductTurn, startIntake } from "@/lib/interview/conduct";
import { blankIntake } from "@/lib/demo/seed";
import { isModelEnabled, isStageEnabled, modelMode } from "@/lib/ai/client";
import { turnUserPrompt, hpiUserPrompt } from "@/lib/ai/prompts";
import { allEvents, resetAnalytics, track } from "@/lib/analytics";

/**
 * The model trust boundary.
 *
 * A practice deciding whether to run this needs a technical answer to one
 * question: can patient text reach a third party, and how would we know? The
 * answer must be demonstrable, not asserted.
 *
 * These tests hold the boundary from both sides — that `off` transmits
 * nothing, and that what IS sent when the model is on is only what the task
 * requires.
 */

const ORIGINAL = { key: process.env.ANTHROPIC_API_KEY, mode: process.env.AION_MODEL_MODE };

/**
 * Deliberately not key-shaped. The code only checks whether the variable is
 * set, and the security smoke test refuses to let anything matching a real
 * credential pattern into the repository — a carve-out for test fixtures is
 * the hole a real key eventually slips through.
 */
const FAKE_KEY = "not-a-real-key";

afterEach(() => {
  if (ORIGINAL.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL.key;
  if (ORIGINAL.mode === undefined) delete process.env.AION_MODEL_MODE;
  else process.env.AION_MODEL_MODE = ORIGINAL.mode;
  vi.unstubAllGlobals();
});

const CLINICAL = "I have an itchy rash on both arms that started about two weeks ago";

/** Records every outbound HTTP request the process attempts. */
function interceptNetwork(): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
    throw new Error("network blocked in test");
  });
  return { calls };
}

async function runInterview(): Promise<void> {
  let intake = startIntake(blankIntake("v_model")).intake;
  for (const answer of [CLINICAL, "both forearms", "two weeks", "it itches at night"]) {
    const res = await conductTurn({ intake, answer, inputMode: "text" });
    intake = res.intake;
    if (res.finished) break;
  }
}

describe("AION_MODEL_MODE=off guarantees no external transmission", () => {
  it("makes no outbound request at all, even with a key present", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.AION_MODEL_MODE = "off";
    const net = interceptNetwork();

    await runInterview();

    expect(net.calls).toEqual([]);
    expect(isModelEnabled()).toBe(false);
    expect(isStageEnabled("turn")).toBe(false);
    expect(isStageEnabled("question")).toBe(false);
    expect(isStageEnabled("hpi")).toBe(false);
  });

  it("is indistinguishable from having no key configured", async () => {
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    process.env.AION_MODEL_MODE = "off";
    const withKeyOff = ["turn", "question", "hpi"].map((s) => isStageEnabled(s as "turn"));

    delete process.env.ANTHROPIC_API_KEY;
    process.env.AION_MODEL_MODE = "full";
    const noKey = ["turn", "question", "hpi"].map((s) => isStageEnabled(s as "turn"));

    expect(withKeyOff).toEqual(noKey);
    expect(withKeyOff).toEqual([false, false, false]);
  });

  it("still produces a complete interview and brief", async () => {
    process.env.AION_MODEL_MODE = "off";
    delete process.env.ANTHROPIC_API_KEY;
    let intake = startIntake(blankIntake("v_det")).intake;
    for (const a of [CLINICAL, "forearms", "two weeks", "itches", "no", "no", "nothing", "no", "clear it up"]) {
      const res = await conductTurn({ intake, answer: a, inputMode: "text" });
      intake = res.intake;
      if (res.finished) break;
    }
    expect(intake.facts.length).toBeGreaterThan(2);
    expect(intake.pathway).toBe("rash");
  });

  it("is reportable at runtime, so a practice can verify the claim", () => {
    process.env.AION_MODEL_MODE = "off";
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    expect(modelMode()).toBe("off");
    expect(isModelEnabled()).toBe(false);
  });

  it("an unrecognised mode does not silently disable the guards", () => {
    // Failing open on model USE is the safe direction: a typo must not quietly
    // turn off the safety paths that only exist on the model code path.
    process.env.AION_MODEL_MODE = "of";
    process.env.ANTHROPIC_API_KEY = FAKE_KEY;
    expect(modelMode()).toBe("full");
  });
});

describe("what the model receives is only what the task needs", () => {
  const prompt = turnUserPrompt({
    askedQuestion: "How long have you had it?",
    askedSlot: "timeline",
    facets: ["onset", "change"],
    answer: CLINICAL,
    nextQuestion: "Does anything make it worse?",
    recentTranscript: "AION: How long have you had it?\nPatient: two weeks",
  });

  it("carries the answer and the question, and no patient identity", () => {
    expect(prompt).toContain(CLINICAL);
    // Nothing that names the person. The model's task is to structure one
    // answer; who said it is irrelevant to that and is not sent.
    for (const identifier of ["Maya", "Ellison", "1991-04-12", "date of birth", "patient name"]) {
      expect(prompt.toLowerCase()).not.toContain(identifier.toLowerCase());
    }
  });

  it("carries no clinician identity, practice name, or visit details", () => {
    for (const s of ["Okonkwo", "Northgate", "practice", "clinician", "appointment"]) {
      expect(prompt.toLowerCase()).not.toContain(s.toLowerCase());
    }
  });

  it("sends one turn of context, not the whole conversation", () => {
    // Resending the transcript every turn is the classic cost trap and a
    // gratuitous widening of what leaves the building.
    expect(prompt.split("\n").length).toBeLessThan(40);
  });

  it("sends an age and a photo COUNT, never a date of birth or photo bytes", () => {
    // The HPI prompt's own signature is the minimization: it takes a number of
    // years, a rendered fact list, and how many photographs exist. There is no
    // parameter through which a date of birth, a name, or image bytes could
    // reach the provider even by mistake.
    const hpi = hpiUserPrompt({
      age: 34,
      facts: `timeline — two weeks — "${CLINICAL}" — stated`,
      photos: 2,
    });
    expect(hpi).toContain("34 years old");
    expect(hpi).toContain("2 patient-supplied reference photograph");
    expect(hpi).not.toContain("data:image");
    expect(hpi).not.toContain("base64");
    expect(hpi).not.toContain("1991-04-12");
    for (const s of ["Maya", "Ellison", "Okonkwo", "Northgate"]) {
      expect(hpi).not.toContain(s);
    }
  });

  it("omits age entirely when it is unknown rather than guessing one", () => {
    expect(hpiUserPrompt({ age: null, facts: "", photos: 0 })).toContain("age not supplied");
  });
});

describe("analytics carry no clinical free text", () => {
  beforeEach(() => resetAnalytics());

  it("drops answer text, names and dates of birth", () => {
    track("intake_question_answered", {
      slot: "timeline",
      answer_text: CLINICAL,
      patient_name: "Maya Ellison",
      dob: "1991-04-12",
      verbatim: CLINICAL,
      question_index: 3,
      certainty: "stated",
    });
    const [event] = allEvents();
    expect(event.props).toEqual({ slot: "timeline", question_index: 3, certainty: "stated" });
    expect(JSON.stringify(allEvents())).not.toContain("itchy rash");
  });

  it("keeps the metadata the wedge is actually measured on", () => {
    track("intake_submitted", {
      intake_id: "int_1",
      pathway: "rash",
      question_count: 7,
      photo_count: 2,
      duration_seconds: 214,
      ai_mode: "deterministic",
    });
    const [event] = allEvents();
    expect(event.props.pathway).toBe("rash");
    expect(event.props.question_count).toBe(7);
    expect(event.props.duration_seconds).toBe(214);
  });
});
