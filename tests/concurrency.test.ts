import { beforeEach, describe, expect, it } from "vitest";
import { POST as startRoute } from "@/app/api/intake/[token]/start/route";
import { POST as messageRoute } from "@/app/api/intake/[token]/message/route";
import { POST as submitRoute } from "@/app/api/intake/[token]/submit/route";
import { POST as photoRoute } from "@/app/api/intake/[token]/photos/route";
import { db, getIntakeByToken, resetDb } from "@/lib/store";
import { withIntakeLock } from "@/lib/store/lock";
import { jpegDataUrl } from "./fixtures/images";
import { MAX_PHOTOS } from "@/lib/photos";

/**
 * Concurrency.
 *
 * Every write route is a read-modify-write across at least one await, so two
 * requests for the same intake could read the same snapshot and the second
 * save could erase the first patient answer. These tests fire real requests
 * simultaneously and assert nothing is lost, nothing doubles, and — the one
 * that would be catastrophic — nothing crosses between two patients.
 */

/** Only the un-started seeded intakes; the rest already carry demo content. */
const freshTokens = () =>
  [...db().intakes.values()].filter((i) => i.status === "not_started").map((i) => i.token);

const post = (
  route: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response>,
  token: string,
  body?: unknown,
) =>
  route(
    new Request("http://t/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ token }) },
  );

const answer = (token: string, text: string) =>
  post(messageRoute, token, { answer: text, inputMode: "text" });

describe("per-intake write serialization", () => {
  beforeEach(() => {
    resetDb();
  });

  it("runs same-key work one at a time and different keys concurrently", async () => {
    const order: string[] = [];
    const slow = (key: string, tag: string, ms: number) =>
      withIntakeLock(key, async () => {
        order.push(`${tag}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${tag}:end`);
      });

    await Promise.all([slow("a", "a1", 20), slow("a", "a2", 1), slow("b", "b1", 1)]);

    // a2 must not start until a1 has finished.
    expect(order.indexOf("a2:start")).toBeGreaterThan(order.indexOf("a1:end"));
    // b1 is a different intake — it must not have waited for the slow a1.
    expect(order.indexOf("b1:end")).toBeLessThan(order.indexOf("a1:end"));
  });

  it("a rejected task does not wedge the queue for that intake", async () => {
    const boom = withIntakeLock("k", async () => {
      throw new Error("boom");
    });
    await expect(boom).rejects.toThrow("boom");
    await expect(withIntakeLock("k", async () => "after")).resolves.toBe("after");
  });

  it("two simultaneous answers both land — neither turn is lost", async () => {
    const [token] = freshTokens();
    await post(startRoute, token);

    await Promise.all([
      answer(token, "Itchy red rash on both of my arms for about two weeks"),
      answer(token, "It is worse at night and keeps me awake"),
    ]);

    const intake = getIntakeByToken(token)!;
    const patientTurns = intake.messages.filter((m) => m.role === "patient");
    expect(patientTurns).toHaveLength(2);
    // Both answers are present; neither overwrote the other.
    const bothAnswers = patientTurns.map((m) => m.text.toLowerCase()).join(" ");
    expect(bothAnswers).toContain("itchy red rash");
    expect(patientTurns.some((m) => m.text.includes("worse at night"))).toBe(true);
    // Every assistant question is followed by exactly one patient answer.
    expect(intake.questionCount).toBe(intake.messages.filter((m) => m.role === "assistant").length);
  });

  it("a double-tapped submit produces one submission, not two", async () => {
    const [token] = freshTokens();
    await post(startRoute, token);
    await answer(token, "A dark mole on my back that has been changing shape");

    const [a, b] = await Promise.all([post(submitRoute, token), post(submitRoute, token)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const intake = getIntakeByToken(token)!;
    expect(intake.status).toBe("ready_for_review");
    expect(intake.submittedAt).toBeTruthy();
    // The HPI was composed once, and the second submit did not recompose it.
    expect(intake.hpi.length).toBeGreaterThan(0);
    expect(intake.hpi).toBe(intake.hpiGenerated);
  });

  it("simultaneous starts do not double the opening question", async () => {
    const [token] = freshTokens();
    await Promise.all([post(startRoute, token), post(startRoute, token), post(startRoute, token)]);
    const intake = getIntakeByToken(token)!;
    expect(intake.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(intake.questionCount).toBe(1);
  });

  it("simultaneous photo uploads cannot exceed the photo cap", async () => {
    const [token] = freshTokens();
    await post(startRoute, token);
    const photo = { dataUrl: jpegDataUrl(1200, 1600), width: 1200, height: 1600, mime: "image/jpeg" };

    await Promise.all(Array.from({ length: 6 }, () => post(photoRoute, token, photo)));

    expect(getIntakeByToken(token)!.photos.length).toBeLessThanOrEqual(MAX_PHOTOS);
  });

  it("two patients interviewed at the same time never see each other's answers", async () => {
    const [a, b] = freshTokens();
    await Promise.all([post(startRoute, a), post(startRoute, b)]);

    // Interleave the two interviews turn for turn.
    const scriptA = [
      "Itchy red rash on both of my forearms for about two weeks",
      "It burns and itches, worse at night",
      "Nothing new, no change in soap or detergent",
      "I tried hydrocortisone from the pharmacy for four days",
    ];
    const scriptB = [
      "My hair has been falling out in handfuls since I gave birth in March",
      "It is coming out all over, not in patches",
      "I wear it in a tight ponytail most days",
      "I have not used anything for it",
    ];
    for (let i = 0; i < scriptA.length; i += 1) {
      await Promise.all([answer(a, scriptA[i]), answer(b, scriptB[i])]);
    }

    const ia = getIntakeByToken(a)!;
    const ib = getIntakeByToken(b)!;

    const textA = JSON.stringify({ facts: ia.facts, messages: ia.messages }).toLowerCase();
    const textB = JSON.stringify({ facts: ib.facts, messages: ib.messages }).toLowerCase();

    // Nothing distinctive to one patient may appear in the other's record.
    for (const marker of ["falling out in handfuls", "gave birth", "ponytail"]) {
      expect(textA).not.toContain(marker);
    }
    for (const marker of ["forearms", "hydrocortisone", "detergent"]) {
      expect(textB).not.toContain(marker);
    }
    expect(ia.pathway).not.toBe(ib.pathway);
    expect(ia.id).not.toBe(ib.id);
  });
});
