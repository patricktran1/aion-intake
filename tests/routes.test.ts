import { beforeEach, describe, expect, it } from "vitest";
import { GET as getIntake } from "@/app/api/intake/[token]/route";
import { POST as startRoute } from "@/app/api/intake/[token]/start/route";
import { POST as messageRoute } from "@/app/api/intake/[token]/message/route";
import { POST as submitRoute } from "@/app/api/intake/[token]/submit/route";
import { PATCH as factsRoute } from "@/app/api/intake/[token]/facts/route";
import { POST as photoRoute } from "@/app/api/intake/[token]/photos/route";
import { PATCH as clinicianRoute } from "@/app/api/clinician/intakes/[id]/route";
import { POST as noteRoute } from "@/app/api/clinician/intakes/[id]/note/route";
import { DEMO_TOKENS } from "@/lib/demo/seed";
import { getIntakeByToken, listBundles, resetDb } from "@/lib/store";
import { resetAnalytics } from "@/lib/analytics";
import { resetRateLimits } from "@/lib/ratelimit";

const TOKEN = DEMO_TOKENS.acne;
const params = (token: string) => ({ params: Promise.resolve({ token }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  resetDb();
  resetAnalytics();
  resetRateLimits();
});

async function completeIntake(token: string) {
  await startRoute(post(), params(token));
  for (let i = 0; i < 12; i += 1) {
    const res = await messageRoute(
      post({ answer: "my acne breaks out along my jaw and it leaves marks", inputMode: "text" }),
      params(token),
    );
    const body = await res.json();
    if (body.finished) break;
  }
}

describe("patient intake API", () => {
  it("rejects an unknown intake link without leaking whether it ever existed", async () => {
    const res = await getIntake(new Request("http://localhost/x"), params("nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("This intake link is no longer valid.");
  });

  it("starts an intake and asks the opening question", async () => {
    const body = await (await startRoute(post(), params(TOKEN))).json();
    expect(body.status).toBe("in_progress");
    expect(body.messages).toHaveLength(1);
  });

  it("resumes an abandoned intake instead of restarting it", async () => {
    await startRoute(post(), params(TOKEN));
    await messageRoute(post({ answer: "my acne is bad", inputMode: "text" }), params(TOKEN));
    const before = getIntakeByToken(TOKEN)!.messages.length;

    // The patient closes the tab and comes back to the same link later.
    const resumed = await (await startRoute(post(), params(TOKEN))).json();
    expect(resumed.messages).toHaveLength(before);
    expect(resumed.status).toBe("in_progress");
  });

  it("survives a malformed request body without losing the patient's work", async () => {
    await startRoute(post(), params(TOKEN));
    const res = await messageRoute(
      new Request("http://localhost/x", { method: "POST", body: "not json" }),
      params(TOKEN),
    );
    expect(res.status).toBe(400);
    expect(getIntakeByToken(TOKEN)!.status).toBe("in_progress");
  });

  it("treats a missing answer field as a skip rather than an error", async () => {
    await startRoute(post(), params(TOKEN));
    const res = await messageRoute(post({ inputMode: "text" }), params(TOKEN));
    expect(res.status).toBe(200);
  });

  it("lets the patient correct the summary before submitting", async () => {
    await startRoute(post(), params(TOKEN));
    await messageRoute(post({ answer: "acne on my jaw", inputMode: "text" }), params(TOKEN));
    await factsRoute(
      new Request("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ slot: "concern", value: "Acne along my jaw and chin, leaving marks" }),
      }),
      params(TOKEN),
    );
    const fact = getIntakeByToken(TOKEN)!.facts.find((f) => f.slot === "concern")!;
    expect(fact.value).toBe("Acne along my jaw and chin, leaving marks");
    expect(fact.verbatim).toBe("Acne along my jaw and chin, leaving marks");
  });

  it("lets the patient delete an answer entirely", async () => {
    await startRoute(post(), params(TOKEN));
    await messageRoute(post({ answer: "acne on my jaw", inputMode: "text" }), params(TOKEN));
    await factsRoute(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ slot: "concern", value: "" }) }),
      params(TOKEN),
    );
    expect(getIntakeByToken(TOKEN)!.facts.some((f) => f.slot === "concern")).toBe(false);
  });

  it("does not create a second submission when the patient double-taps", async () => {
    await completeIntake(TOKEN);
    const first = await (await submitRoute(post(), params(TOKEN))).json();
    const submittedAt = getIntakeByToken(TOKEN)!.submittedAt;
    const second = await (await submitRoute(post(), params(TOKEN))).json();
    expect(first.status).toBe("ready_for_review");
    expect(second.status).toBe("ready_for_review");
    expect(getIntakeByToken(TOKEN)!.submittedAt).toBe(submittedAt);
    expect(listBundles().filter((b) => b.intake.token === TOKEN)).toHaveLength(1);
  });

  it("ignores further answers once the intake has been submitted", async () => {
    await completeIntake(TOKEN);
    await submitRoute(post(), params(TOKEN));
    const factsBefore = getIntakeByToken(TOKEN)!.facts.length;
    await messageRoute(post({ answer: "one more thing", inputMode: "text" }), params(TOKEN));
    expect(getIntakeByToken(TOKEN)!.facts).toHaveLength(factsBefore);
  });
});

describe("photo upload API", () => {
  const jpeg = `data:image/jpeg;base64,${"A".repeat(4000)}`;

  it("accepts a valid photo", async () => {
    const res = await photoRoute(
      post({ dataUrl: jpeg, width: 1400, height: 1050, mime: "image/jpeg", kind: "wide" }),
      params(TOKEN),
    );
    expect(res.status).toBe(200);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(1);
  });

  it("refuses anything that is not an image payload", async () => {
    const res = await photoRoute(
      post({ dataUrl: "data:text/html,<script>", width: 1400, height: 1050, mime: "text/html" }),
      params(TOKEN),
    );
    expect(res.status).toBe(400);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(0);
  });

  it("stops at three photos", async () => {
    for (let i = 0; i < 3; i += 1) {
      await photoRoute(post({ dataUrl: jpeg, width: 1400, height: 1050, mime: "image/jpeg" }), params(TOKEN));
    }
    const res = await photoRoute(
      post({ dataUrl: jpeg, width: 1400, height: 1050, mime: "image/jpeg" }),
      params(TOKEN),
    );
    expect(res.status).toBe(400);
    expect(getIntakeByToken(TOKEN)!.photos).toHaveLength(3);
  });
});

describe("clinician API", () => {
  const readyId = () => listBundles().find((b) => b.intake.status === "ready_for_review")!.intake.id;

  it("saves a physician's HPI edit and marks it as edited", async () => {
    const id = readyId();
    await clinicianRoute(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ hpi: "My own version of the history." }) }),
      idParams(id),
    );
    const intake = listBundles().find((b) => b.intake.id === id)!.intake;
    expect(intake.hpi).toBe("My own version of the history.");
    expect(intake.hpiEditedByClinician).toBe(true);
  });

  it("never lets the clinician side overwrite patient-supplied facts", async () => {
    const id = readyId();
    const before = JSON.stringify(listBundles().find((b) => b.intake.id === id)!.intake.facts);
    await clinicianRoute(
      new Request("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ hpi: "x", facts: [], review: { assessment: "something" } }),
      }),
      idParams(id),
    );
    const after = JSON.stringify(listBundles().find((b) => b.intake.id === id)!.intake.facts);
    expect(after).toBe(before);
  });

  it("marks the intake reviewed once findings are entered", async () => {
    const id = readyId();
    await clinicianRoute(
      new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ review: { assessment: "Flare." } }) }),
      idParams(id),
    );
    expect(listBundles().find((b) => b.intake.id === id)!.intake.status).toBe("reviewed");
  });

  it("generates a note that keeps the clinician's findings separate", async () => {
    const id = readyId();
    await clinicianRoute(
      new Request("http://localhost/x", {
        method: "PATCH",
        body: JSON.stringify({ review: { exam: "Flexural plaques.", assessment: "Flare.", plan: "Topical steroid." } }),
      }),
      idParams(id),
    );
    const body = await (await noteRoute(post(), idParams(id))).json();
    expect(body.note).toContain("EXAMINATION (clinician-entered)");
    expect(body.note).toContain("Flexural plaques.");
    expect(body.note.indexOf("HISTORY OF PRESENT ILLNESS")).toBeLessThan(body.note.indexOf("EXAMINATION"));
  });

  it("returns 404 for an unknown intake", async () => {
    const res = await noteRoute(post(), idParams("int_missing"));
    expect(res.status).toBe(404);
  });
});
