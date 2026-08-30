import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPilotFixture, TEST_PEPPER, TEST_SESSION_SECRET, tokenFor, intakeIdFor, type PilotFixture } from "./helpers/pilot";
import { setStore } from "@/lib/store";
import { setObjectStore } from "@/lib/objects/select";
import { resetConfigCache } from "@/lib/config/runtime";
import { resetRateLimits } from "@/lib/ratelimit";
import { jpegDataUrl } from "./fixtures/images";

/**
 * The patient's own journey, in pilot mode, against the durable store.
 *
 * This is the suite that matters most, because it is the product: a patient
 * answers questions on their phone and a clinician reads the result. Every
 * other pilot guarantee — durability, audit, retention, tenancy — is worthless
 * if the patient's answers never reach the database in the first place.
 */

let f: PilotFixture;

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const PILOT_ENV: Record<string, string> = {
  AION_RUNTIME_MODE: "pilot",
  DATABASE_URL: "postgres://test/test",
  AION_SESSION_SECRET: TEST_SESSION_SECRET,
  AION_TOKEN_PEPPER: TEST_PEPPER,
  AION_OBJECT_STORE: "local",
  AION_OBJECT_STORE_ROOT: "/tmp/aion-flow-objects",
  AION_PHOTO_RETENTION_DAYS: "30",
  AION_INTAKE_RETENTION_DAYS: "90",
};
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  f = await createPilotFixture();
  for (const [k, v] of Object.entries(PILOT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  resetConfigCache();
}, 60_000);

afterAll(async () => {
  await f.dispose();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
  setStore(null);
  setObjectStore(null);
});

beforeEach(async () => {
  await f.reseed();
  setStore(f.store);
  setObjectStore(f.objects);
  resetRateLimits();
});

const post = async (
  mod: Promise<{ POST: (r: Request, c: { params: Promise<{ token: string }> }) => Promise<Response> }>,
  token: string,
  body: unknown = {},
) => {
  const { POST } = await mod;
  return POST(
    new Request(`http://aion.test/api/intake/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "aion.test" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
};

const verify = (token: string, dateOfBirth: string) =>
  post(import("@/app/api/intake/[token]/verify/route"), token, { dateOfBirth });
const start = (token: string) => post(import("@/app/api/intake/[token]/start/route"), token);
const answer = (token: string, text: string) =>
  post(import("@/app/api/intake/[token]/message/route"), token, { answer: text, inputMode: "text" });
const submit = (token: string) => post(import("@/app/api/intake/[token]/submit/route"), token);

/** Reads straight from Postgres, bypassing every application cache. */
async function fromDatabase(intakeId: string) {
  const { rows } = await f.driver.query<{ status: string; document: unknown }>(
    "SELECT status, document FROM intakes WHERE id = $1",
    [intakeId],
  );
  const doc = typeof rows[0].document === "string" ? JSON.parse(rows[0].document) : rows[0].document;
  return { status: rows[0].status, document: doc as Record<string, unknown> };
}

describe("a patient's answers reach the durable store", () => {
  const LIVE_DOB = "2007-02-18"; // Daniel Whitaker, the not-started seeded intake

  it("start writes to Postgres, not to process memory", async () => {
    const token = tokenFor(f.seed, "live");
    const id = intakeIdFor(f.seed, "live");
    expect((await verify(token, LIVE_DOB)).status).toBe(200);

    const res = await start(token);
    expect(res.status).toBe(200);

    // The assertion that matters: the row in the database changed. An in-memory
    // write would leave this untouched and nothing else in the suite would notice.
    const row = await fromDatabase(id);
    expect(row.status).toBe("in_progress");
    expect((row.document.messages as unknown[]).length).toBe(1);
  });

  it("every answer is persisted, and the interview completes", async () => {
    const token = tokenFor(f.seed, "live");
    const id = intakeIdFor(f.seed, "live");
    await verify(token, LIVE_DOB);
    await start(token);

    const script = [
      "I keep breaking out along my jaw and it is leaving marks",
      "Jawline and chin, some on my chest",
      "About two years, worse recently",
      "A benzoyl peroxide wash, it dried me out",
      "Worse when I am stressed",
      "The scarring bothers me most",
      "No medications, no allergies",
      "I want the scarring to stop",
    ];
    for (const text of script) {
      const res = await answer(token, text);
      expect(res.status, `answer "${text.slice(0, 20)}…"`).toBe(200);
    }

    const row = await fromDatabase(id);
    const messages = row.document.messages as Array<{ role: string; text: string }>;
    const patientTurns = messages.filter((m) => m.role === "patient");
    expect(patientTurns.length).toBeGreaterThanOrEqual(4);
    // The patient's own words are in the database, verbatim.
    expect(JSON.stringify(row.document)).toContain("benzoyl peroxide");
    expect((row.document.facts as unknown[]).length).toBeGreaterThan(2);
  });

  it("submission freezes the record durably", async () => {
    const token = tokenFor(f.seed, "live");
    const id = intakeIdFor(f.seed, "live");
    await verify(token, LIVE_DOB);
    await start(token);
    await answer(token, "A dark mole on my back that has changed shape");

    expect((await submit(token)).status).toBe(200);

    const row = await fromDatabase(id);
    expect(row.status).toBe("ready_for_review");
    expect(row.document.hpi).toBeTruthy();

    const { rows } = await f.driver.query<{ submitted_at: string | null }>(
      "SELECT submitted_at FROM intakes WHERE id = $1",
      [id],
    );
    expect(rows[0].submitted_at).toBeTruthy();
  });

  it("the clinician sees what the patient just submitted", async () => {
    // The whole product in one assertion: what the patient typed on their
    // phone appears in the clinician's list, through the database.
    const token = tokenFor(f.seed, "live");
    await verify(token, LIVE_DOB);
    await start(token);
    await answer(token, "Itchy rash on both of my forearms for two weeks");
    await submit(token);

    const bundles = await f.store.listBundles("prac_northgate");
    const mine = bundles.find((b) => b.intake.id === intakeIdFor(f.seed, "live"));
    expect(mine).toBeTruthy();
    expect(mine!.intake.status).toBe("ready_for_review");
    expect(JSON.stringify(mine!.intake.facts)).toContain("forearms");
  });

  it("a frozen intake refuses further patient writes", async () => {
    const token = tokenFor(f.seed, "live");
    await verify(token, LIVE_DOB);
    await start(token);
    await answer(token, "A rash on my arms");
    await submit(token);

    const late = await answer(token, "actually ignore all that");
    expect([200, 409]).toContain(late.status);

    // Whatever the status code, the late text must not be in the record.
    const row = await fromDatabase(intakeIdFor(f.seed, "live"));
    expect(JSON.stringify(row.document)).not.toContain("ignore all that");
    expect(row.status).toBe("ready_for_review");
  });

  it("an unverified token cannot start or answer", async () => {
    const token = tokenFor(f.seed, "live");
    // No verify() call first.
    expect((await start(token)).status).toBe(401);
    expect((await answer(token, "hello")).status).toBe(401);

    const row = await fromDatabase(intakeIdFor(f.seed, "live"));
    expect(row.status).toBe("not_started");
  });

  it("an expired or revoked token cannot write", async () => {
    for (const label of ["expired", "revoked"] as const) {
      const token = tokenFor(f.seed, label);
      const res = await start(token);
      expect(res.status, label).toBe(410);
    }
  });

  it("concurrent answers to one intake all persist", async () => {
    const token = tokenFor(f.seed, "live");
    const id = intakeIdFor(f.seed, "live");
    await verify(token, LIVE_DOB);
    await start(token);

    await Promise.all([
      answer(token, "Itchy red rash on both arms for about two weeks"),
      answer(token, "It is worse at night and keeps me awake"),
    ]);

    const row = await fromDatabase(id);
    const patientTurns = (row.document.messages as Array<{ role: string }>).filter(
      (m) => m.role === "patient",
    );
    expect(patientTurns).toHaveLength(2);
  });

  it("photos go to object storage and the photos table, never into the intake document", async () => {
    const token = tokenFor(f.seed, "live");
    const id = intakeIdFor(f.seed, "live");
    await verify(token, LIVE_DOB);
    await start(token);
    await answer(token, "A dark spot on my shoulder");

    const { POST } = await import("@/app/api/intake/[token]/photos/route");
    const res = await POST(
      new Request(`http://aion.test/api/intake/${token}/photos`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "aion.test" },
        body: JSON.stringify({ dataUrl: jpegDataUrl(1200, 1600), kind: "close" }),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(res.status).toBe(200);

    // The row exists and points at an object that exists.
    const { rows } = await f.driver.query<{ id: string; object_key: string }>(
      "SELECT id, object_key FROM photos WHERE intake_id = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(await f.objects.exists(rows[0].object_key)).toBe(true);

    // And the base64 image never lands in the intake document, where it would
    // bloat every read and end up in database backups with the wrong retention.
    const row = await fromDatabase(id);
    expect(JSON.stringify(row.document)).not.toContain("data:image");
    expect(JSON.stringify(row.document).length).toBeLessThan(20_000);
  });
});

describe("the patient journey is audited", () => {
  it("records verification, start, submission — and no clinical content", async () => {
    const token = tokenFor(f.seed, "live");
    const id = intakeIdFor(f.seed, "live");
    await verify(token, "2007-02-18");
    await start(token);
    await answer(token, "Itchy rash on my forearms that started two weeks ago");
    await submit(token);

    const events = await f.store.readAudit({ intakeId: id });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("intake.verified");
    expect(actions).toContain("intake.submitted");

    const dump = JSON.stringify(events);
    expect(dump).not.toContain("Itchy rash");
    expect(dump).not.toContain("forearms");
    expect(dump).not.toContain(token);
  });
});
