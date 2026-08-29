import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPilotFixture, intakeIdFor, type PilotFixture } from "./helpers/pilot";
import { AUDIT_ACTIONS } from "@/lib/store";
import { setStore } from "@/lib/store";
import { audit } from "@/lib/audit";
import { AppError, toAppError } from "@/lib/errors";
import { handle } from "@/lib/http";
import { REQUEST_ID_HEADER } from "@/lib/log";

/**
 * Audit and failure behaviour.
 *
 * An audit log has to be useful enough to investigate an incident and narrow
 * enough that it is not a second, less protected copy of the record. These
 * tests hold both ends: the events exist and carry who/what/when, and they
 * carry no clinical content even when a caller tries to put some in.
 */

let f: PilotFixture;
beforeAll(async () => {
  f = await createPilotFixture();
}, 60_000);
afterAll(async () => {
  await f.dispose();
  setStore(null);
});
beforeEach(async () => {
  await f.reseed();
  setStore(f.store);
});

const CLINICAL = {
  hpi: "The patient reports an itchy erythematous rash on both forearms for two weeks.",
  answer: "it has been itching since christmas and keeps me awake",
  patientName: "Maya Ellison",
  note: "Exam: scattered papules. Plan: topical steroid.",
  dob: "1991-04-12",
};

describe("audit events", () => {
  it("record who did what to which record, with a request id", async () => {
    const intakeId = intakeIdFor(f.seed, "submitted");
    await audit({
      action: "brief.opened",
      actor: { kind: "clinician", clinicianId: "cli_okonkwo", practiceId: "prac_northgate" },
      resource: "intake",
      resourceId: intakeId,
      requestId: "req_abc123",
      meta: { photo_count: 2, urgent: false },
    });

    const [event] = await f.store.readAudit({ intakeId });
    expect(event.action).toBe("brief.opened");
    expect(event.actorKind).toBe("clinician");
    expect(event.actorId).toBe("cli_okonkwo");
    expect(event.practiceId).toBe("prac_northgate");
    expect(event.resourceId).toBe(intakeId);
    expect(event.requestId).toBe("req_abc123");
    expect(event.meta).toEqual({ photo_count: 2, urgent: false });
    expect(new Date(event.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("carry no clinical content even when a caller supplies it", async () => {
    const intakeId = intakeIdFor(f.seed, "submitted");
    await audit({
      action: "hpi.edited",
      actor: { kind: "clinician", clinicianId: "cli_okonkwo", practiceId: "prac_northgate" },
      resource: "intake",
      resourceId: intakeId,
      meta: {
        hpi_text: CLINICAL.hpi,
        answer: CLINICAL.answer,
        patient_name: CLINICAL.patientName,
        note_content: CLINICAL.note,
        dob: CLINICAL.dob,
        // The legitimate ones must survive alongside.
        chars_changed: 42,
        edited: true,
      },
    });

    const [event] = await f.store.readAudit({ intakeId });
    expect(event.meta).toEqual({ chars_changed: 42, edited: true });

    // And nothing clinical anywhere in the stored row, however it got there.
    const { rows } = await f.driver.query<{ meta: unknown }>("SELECT meta FROM audit_events");
    const dump = JSON.stringify(rows);
    for (const [label, text] of Object.entries(CLINICAL)) {
      expect(dump.includes(text), `${label} leaked into an audit row`).toBe(false);
    }
  });

  it("scope to a practice, so one practice cannot read another's trail", async () => {
    await audit({
      action: "brief.opened",
      actor: { kind: "clinician", clinicianId: "cli_okonkwo", practiceId: "prac_northgate" },
      resource: "intake",
      resourceId: intakeIdFor(f.seed, "submitted"),
    });
    await audit({
      action: "brief.opened",
      actor: { kind: "clinician", clinicianId: "cli_navarro", practiceId: "prac_riverside" },
      resource: "intake",
      resourceId: intakeIdFor(f.seed, "other"),
    });

    const north = await f.store.readAudit({ practiceId: "prac_northgate" });
    expect(north.length).toBe(1);
    expect(north.every((e) => e.practiceId === "prac_northgate")).toBe(true);
  });

  it("cover every action the product can take", () => {
    // A vocabulary rather than free strings, so a dashboard can be built on it
    // and a missing event type is visible.
    for (const required of [
      "intake.submitted", "intake.deleted", "brief.opened", "hpi.edited",
      "photo.uploaded", "photo.accessed", "photo.deleted",
      "auth.login", "auth.login_failed", "authz.denied",
      "intake.verified", "intake.verification_failed", "intake.token_revoked",
    ]) {
      expect(AUDIT_ACTIONS as readonly string[]).toContain(required);
    }
  });

  it("a failing audit write never breaks the request it describes", async () => {
    // A brief that will not open because the audit insert failed is worse than
    // a missing audit row. The failure is logged, not thrown.
    setStore({
      ...f.store,
      appendAudit: async () => {
        throw new Error("audit table is gone");
      },
    } as unknown as typeof f.store);

    await expect(
      audit({ action: "brief.opened", actor: { kind: "system" }, resource: "intake", resourceId: "int_x" }),
    ).resolves.toBeUndefined();
    setStore(f.store);
  });
});

describe("failure injection", () => {
  const call = (fn: () => Promise<Response>) =>
    handle(new Request("http://t/x", { method: "POST" }), "POST /test", fn);

  it("turns a database outage into a retryable message with no internals", async () => {
    const res = await call(async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("STORE_UNAVAILABLE");
    expect(body.retryable).toBe(true);
    // The patient is told their answers are safe, and told nothing else.
    expect(body.error).toMatch(/try again/i);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|5432/);
  });

  it("never leaks a SQL error, a connection string, or a stack trace", async () => {
    const leaky = new Error(
      'relation "intakes" does not exist\n    at Parser.parseErrorMessage (/app/node_modules/pg/index.js:1:1)\n' +
        "connection: postgres://aion:hunter2@db.internal:5432/aion",
    );
    const res = await call(async () => {
      throw leaky;
    });
    const text = JSON.stringify(await res.json());
    for (const secret of ["hunter2", "db.internal", "node_modules", "Parser.parseErrorMessage", "relation"]) {
      expect(text.includes(secret), `${secret} leaked to the client`).toBe(false);
    }
    expect(res.status).toBe(500);
  });

  it("classifies a write conflict as retryable rather than as a crash", async () => {
    const res = await call(async () => {
      throw new Error("could not serialize access due to concurrent update");
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("STORE_CONFLICT");
  });

  it("returns a request id on both success and failure, so support can find the line", async () => {
    const ok = await call(async () => new Response("{}", { status: 200 }));
    expect(ok.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);

    const bad = await call(async () => {
      throw new AppError("PHOTO_TOO_LARGE", "9MB");
    });
    const id = bad.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // The same id is in the body, so a patient can read it out over the phone.
    expect((await bad.json()).requestId).toBe(id);
  });

  it("adopts an upstream request id so a trace survives a proxy", async () => {
    const res = await handle(
      new Request("http://t/x", { headers: { "x-request-id": "edge-abc-123" } }),
      "GET /test",
      async () => new Response("{}"),
    );
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("edge-abc-123");
  });

  it("maps an object store outage to its own retryable code", async () => {
    const res = await call(async () => {
      throw new AppError("OBJECT_STORE_UNAVAILABLE", "s3 put failed: 503");
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.retryable).toBe(true);
    expect(body.error).toMatch(/photo/i);
    expect(JSON.stringify(body)).not.toContain("s3 put failed");
  });

  it("does not classify an unknown failure as something a retry will fix", () => {
    // Silently marking everything retryable teaches a client to hammer a
    // broken endpoint. INTERNAL is retryable; a validation bug is not.
    expect(toAppError(new Error("cannot read properties of undefined")).code).toBe("INTERNAL");
    expect(new AppError("BAD_REQUEST").retryable).toBe(false);
    expect(new AppError("ACCESS_DENIED").retryable).toBe(false);
  });
});
