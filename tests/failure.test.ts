import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getIntake } from "@/app/api/intake/[token]/route";
import { POST as startRoute } from "@/app/api/intake/[token]/start/route";
import { POST as messageRoute } from "@/app/api/intake/[token]/message/route";
import { POST as submitRoute } from "@/app/api/intake/[token]/submit/route";
import { PATCH as factsRoute } from "@/app/api/intake/[token]/facts/route";
import { POST as photoRoute } from "@/app/api/intake/[token]/photos/route";
import { DELETE as photoDeleteRoute } from "@/app/api/intake/[token]/photos/[photoId]/route";
import { PATCH as clinicianRoute } from "@/app/api/clinician/intakes/[id]/route";
import { POST as noteRoute } from "@/app/api/clinician/intakes/[id]/note/route";
import { POST as analyticsRoute } from "@/app/api/analytics/route";
import { POST as resetRoute } from "@/app/api/demo/reset/route";
import { DEMO_TOKENS, blankIntake } from "@/lib/demo/seed";
import { db, getIntakeByToken, listBundles, resetDb } from "@/lib/store";
import { resetAnalytics, summarize } from "@/lib/analytics";
import { resetRateLimits } from "@/lib/ratelimit";
import { conductTurn, generateHpi, parseTurn, startIntake } from "@/lib/interview/conduct";
import { composeHpiDeterministic } from "@/lib/ai/compose";
import type { IntakeBundle } from "@/lib/domain/types";

/**
 * Failure injection.
 *
 * Every case here is a way the product can break in the field. The bar is not
 * that nothing goes wrong — it is that when something does, the patient is
 * never trapped, the physician is never shown something false, and no screen
 * ever goes blank.
 */

const TOKEN = DEMO_TOKENS.acne;
const params = (token: string) => ({ params: Promise.resolve({ token }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const patch = (body: unknown) =>
  new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) });
const readyId = () => listBundles().find((b) => b.intake.status === "ready_for_review")!.intake.id;

beforeEach(() => {
  resetDb();
  resetAnalytics();
  resetRateLimits();
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => vi.restoreAllMocks());

describe("bad requests never take the app down", () => {
  const badBodies = [
    "not json at all",
    "{",
    "[]",
    "null",
    '{"answer": 12345}',
    '{"answer": {"nested": true}}',
    '{"answer": []}',
  ];

  it.each(badBodies)("survives a message body of %s", async (body) => {
    await startRoute(post(), params(TOKEN));
    const res = await messageRoute(
      new Request("http://localhost/x", { method: "POST", body }),
      params(TOKEN),
    );
    expect([200, 400]).toContain(res.status);
    expect(getIntakeByToken(TOKEN)).toBeDefined();
  });

  it.each(badBodies)("survives a photo body of %s", async (body) => {
    const res = await photoRoute(
      new Request("http://localhost/x", { method: "POST", body }),
      params(TOKEN),
    );
    expect([200, 400]).toContain(res.status);
  });

  it("survives a facts edit with no slot", async () => {
    expect((await factsRoute(patch({ value: "something" }), params(TOKEN))).status).toBe(400);
  });

  it("ignores a facts edit for a slot that does not exist", async () => {
    await startRoute(post(), params(TOKEN));
    expect((await factsRoute(patch({ slot: "not_a_real_slot", value: "x" }), params(TOKEN))).status).toBe(200);
  });

  it("rejects an unknown analytics event rather than recording it", async () => {
    expect((await analyticsRoute(post({ event: "steal_everything" }))).status).toBe(400);
    expect((await analyticsRoute(post({ event: "clinician_hpi_copied" }))).status).toBe(200);
  });

  it("returns a clear 404 for an invalid intake token", async () => {
    for (const bad of ["", "nope", "../../etc/passwd", "%00", "a".repeat(500)]) {
      const res = await getIntake(new Request("http://localhost/x"), params(bad));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBeTruthy();
    }
  });

  it("returns 404 rather than throwing for an unknown intake id", async () => {
    expect((await clinicianRoute(patch({ hpi: "x" }), idParams("int_nope"))).status).toBe(404);
    expect((await noteRoute(post(), idParams("int_nope"))).status).toBe(404);
  });
});

describe("the model failing never blocks the patient", () => {
  it("falls back to deterministic extraction when the model errors", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const client = await import("@/lib/ai/client");
    vi.spyOn(client, "callTool").mockResolvedValue({
      ok: false,
      data: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: "network down",
    });

    const intake = startIntake(blankIntake("v")).intake;
    const r = await conductTurn({
      intake,
      answer: "I have an itchy rash on both my arms",
      inputMode: "text",
    });
    expect(r.intake.facts.some((f) => f.slot === "concern")).toBe(true);
    expect(r.nextQuestion).toBeTruthy();
  });

  it("falls back when the model returns a malformed payload", () => {
    const at = new Date().toISOString();
    for (const bad of [null, undefined, "", 42, [], {}, { facts: null }, { facts: {} }]) {
      expect(parseTurn(bad, ["concern"], "a rash", at)).toBeNull();
    }
  });

  it("drops individual malformed facts without losing the good ones", () => {
    const at = new Date().toISOString();
    const parsed = parseTurn(
      {
        facts: [
          null,
          "string",
          { slot: "concern" },
          { slot: "concern", value: "", verbatim: "x", certainty: "stated" },
          { slot: "concern", value: "A rash", verbatim: "a rash", certainty: "stated" },
        ],
        patient_questions: [null, 5, "Will it scar?"],
        next_question: "Where is it?",
      },
      ["concern"],
      "I have a rash",
      at,
    );
    expect(parsed?.facts).toHaveLength(1);
    expect(parsed?.patientQuestions).toEqual(["Will it scar?"]);
  });

  it("produces a usable HPI with no model configured at all", async () => {
    const b = listBundles().find((x) => x.intake.status === "ready_for_review")!;
    const { intake, usedModel } = await generateHpi(b);
    expect(usedModel).toBe(false);
    expect(intake.hpi.length).toBeGreaterThan(80);
    expect(intake.aiUsage.estimatedCostUsd).toBe(0);
  });
});

describe("the patient is never trapped", () => {
  it("always offers a way forward after an empty answer", async () => {
    await startRoute(post(), params(TOKEN));
    for (let i = 0; i < 12; i += 1) {
      const res = await messageRoute(post({ answer: "", inputMode: "text" }), params(TOKEN));
      expect(res.status).toBe(200);
      if ((await res.json()).finished) return;
    }
    throw new Error("the interview never ended for a silent patient");
  });

  it("can always submit, even having answered nothing", async () => {
    await startRoute(post(), params(TOKEN));
    expect((await submitRoute(post(), params(TOKEN))).status).toBe(200);
    expect(getIntakeByToken(TOKEN)!.status).toBe("ready_for_review");
  });

  it("resumes at the same place after a refresh mid-interview", async () => {
    await startRoute(post(), params(TOKEN));
    await messageRoute(post({ answer: "acne on my jaw", inputMode: "text" }), params(TOKEN));
    const before = await (await getIntake(new Request("http://localhost/x"), params(TOKEN))).json();
    const after = await (await getIntake(new Request("http://localhost/x"), params(TOKEN))).json();
    expect(after.messages).toHaveLength(before.messages.length);
    expect(after.status).toBe("in_progress");
  });

  it("shows the finished state after a refresh post-submission", async () => {
    await startRoute(post(), params(TOKEN));
    await submitRoute(post(), params(TOKEN));
    const view = await (await getIntake(new Request("http://localhost/x"), params(TOKEN))).json();
    expect(view.status).toBe("ready_for_review");
  });

  it("does not lose a photo when a later upload fails", async () => {
    const jpeg = `data:image/jpeg;base64,${"A".repeat(4000)}`;
    await photoRoute(post({ dataUrl: jpeg, width: 1400, height: 1050, mime: "image/jpeg" }), params(TOKEN));
    await photoRoute(post({ dataUrl: "garbage", width: 10, height: 10, mime: "x" }), params(TOKEN));
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(1);
  });

  it("recovers cleanly when a photo is deleted twice", async () => {
    const jpeg = `data:image/jpeg;base64,${"A".repeat(4000)}`;
    await photoRoute(post({ dataUrl: jpeg, width: 1400, height: 1050, mime: "image/jpeg" }), params(TOKEN));
    const id = getIntakeByToken(TOKEN)!.photos[0].id;
    const del = () =>
      photoDeleteRoute(new Request("http://x"), {
        params: Promise.resolve({ token: TOKEN, photoId: id }),
      });
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(200);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(0);
  });
});

describe("corrupted state degrades rather than crashes", () => {
  it("renders a brief for an intake whose facts were wiped", () => {
    const b = listBundles().find((x) => x.intake.status === "ready_for_review")!;
    const broken: IntakeBundle = { ...b, intake: { ...b.intake, facts: [], messages: [] } };
    expect(() => composeHpiDeterministic(broken)).not.toThrow();
    expect(composeHpiDeterministic(broken)).toContain("presents");
  });

  it("survives an intake pointing at a visit that no longer exists", () => {
    const intake = getIntakeByToken(TOKEN)!;
    db().visits.delete(intake.visitId);
    expect(() => listBundles()).not.toThrow();
    expect(listBundles().every((x) => x.intake.token !== TOKEN)).toBe(true);
  });

  it("restores everything after a reset", async () => {
    db().intakes.clear();
    db().visits.clear();
    expect(listBundles()).toHaveLength(0);
    await resetRoute(post());
    expect(listBundles().length).toBeGreaterThan(0);
    expect(getIntakeByToken(TOKEN)?.status).toBe("not_started");
  });

  it("does not carry analytics across a reset", async () => {
    await startRoute(post(), params(TOKEN));
    await resetRoute(post());
    expect(summarize().intakes_started).toBe(0);
  });
});

describe("hostile input", () => {
  const NASTY = [
    "<script>alert(1)</script>",
    "'; DROP TABLE intakes; --",
    "{{constructor.constructor('return process')()}}",
    " ",
    "\u{1F62D}".repeat(500),
    "a".repeat(20000),
    "../../../../etc/passwd",
  ];

  it.each(NASTY)("stores hostile input without corrupting the intake", async (answer) => {
    await startRoute(post(), params(TOKEN));
    const res = await messageRoute(post({ answer, inputMode: "text" }), params(TOKEN));
    expect(res.status).toBe(200);
    for (const f of getIntakeByToken(TOKEN)!.facts) {
      expect(f.value.length).toBeLessThanOrEqual(400);
      expect(f.verbatim.length).toBeLessThanOrEqual(2000);
    }
  });

  it("bounds an oversized clinician HPI edit", async () => {
    const id = readyId();
    await clinicianRoute(patch({ hpi: "x".repeat(100_000) }), idParams(id));
    expect(listBundles().find((b) => b.intake.id === id)!.intake.hpi.length).toBeLessThanOrEqual(20_000);
  });

  it("rejects review fields that are not strings", async () => {
    const res = await clinicianRoute(patch({ review: { exam: { evil: true } } }), idParams(readyId()));
    expect(res.status).toBe(400);
  });

  it("bounds every clinician review field", async () => {
    const id = readyId();
    await clinicianRoute(patch({ review: { exam: "e".repeat(100_000) } }), idParams(id));
    expect(listBundles().find((b) => b.intake.id === id)!.intake.review.exam.length).toBeLessThanOrEqual(20_000);
  });
});

describe("rate limiting", () => {
  it("lets an ordinary intake through without ever tripping", async () => {
    await startRoute(post(), params(TOKEN));
    for (let i = 0; i < 12; i += 1) {
      const res = await messageRoute(
        post({ answer: "itchy rash on my arms", inputMode: "text" }),
        params(TOKEN),
      );
      expect(res.status).toBe(200);
      if ((await res.json()).finished) break;
    }
  });

  it("stops a flood of writes", async () => {
    await startRoute(post(), params(TOKEN));
    let limited = false;
    for (let i = 0; i < 60; i += 1) {
      const res = await messageRoute(post({ answer: "x", inputMode: "text" }), params(TOKEN));
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("refuses a demo reset from another origin", async () => {
    const cross = new Request("http://localhost/api/demo/reset", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect((await resetRoute(cross)).status).toBe(403);
  });

  it("allows a same-origin demo reset", async () => {
    const same = new Request("http://localhost/api/demo/reset", {
      method: "POST",
      headers: { origin: "http://localhost" },
    });
    expect((await resetRoute(same)).status).toBe(200);
  });

  it("refills over time rather than locking a patient out permanently", async () => {
    const { LIMITS, allow } = await import("@/lib/ratelimit");
    const t0 = 1_000_000;
    for (let i = 0; i < LIMITS.intakeWrite.burst; i += 1) {
      expect(allow("k", LIMITS.intakeWrite, t0)).toBe(true);
    }
    expect(allow("k", LIMITS.intakeWrite, t0)).toBe(false);
    expect(allow("k", LIMITS.intakeWrite, t0 + 10_000)).toBe(true);
  });
});

describe("photo uploads accept only raster images", () => {
  const raster = `data:image/jpeg;base64,${"A".repeat(4000)}`;

  it("accepts a JPEG from the browser", async () => {
    const res = await photoRoute(
      post({ dataUrl: raster, width: 1400, height: 1050, mime: "image/jpeg" }),
      params(TOKEN),
    );
    expect(res.status).toBe(200);
  });

  it.each([
    "data:image/svg+xml;utf8,<svg onload='alert(1)'></svg>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "javascript:alert(1)",
    "https://evil.example/x.jpg",
  ])("refuses %s", async (dataUrl) => {
    const res = await photoRoute(
      post({ dataUrl, width: 1400, height: 1050, mime: "image/jpeg" }),
      params(TOKEN),
    );
    expect(res.status).toBe(400);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(0);
  });
});

describe("model errors are reduced to a fixed vocabulary", () => {
  it("never records a raw provider message", async () => {
    const { errorReason } = await import("@/lib/ai/client");
    const secretish = new Error("401 unauthorized for key sk-ant-abc123 at https://api.internal/x");
    expect(errorReason(secretish)).toBe("auth");
    expect(errorReason(new Error("socket hang up ECONNRESET"))).toBe("network");
    expect(errorReason(new Error("Request timed out"))).toBe("timeout");
    expect(errorReason(new Error("something unexpected"))).toBe("other");
  });
});
