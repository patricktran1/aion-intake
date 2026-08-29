import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "@/lib/config/runtime";
import { __testing, requestIdFrom } from "@/lib/log";
import { sanitizeMeta } from "@/lib/audit";
import { AppError, ERROR_CODES, errorSpec, toAppError } from "@/lib/errors";

/**
 * Deployment guards.
 *
 * The accident these tests exist to prevent is a configuration mistake that
 * quietly changes what the software is: a public demo pointed at a pilot
 * database, or a pilot running with a placeholder secret. Both are one missing
 * environment variable away, and both fail silently unless something refuses
 * to start.
 */

const BASE_PILOT: Record<string, string> = {
  AION_RUNTIME_MODE: "pilot",
  DATABASE_URL: "postgres://user:pw@localhost:5432/aion",
  AION_SESSION_SECRET: "s".repeat(40),
  AION_TOKEN_PEPPER: "p".repeat(40),
  AION_OBJECT_STORE: "local",
  AION_OBJECT_STORE_ROOT: "/var/aion/objects",
  AION_PHOTO_RETENTION_DAYS: "30",
  AION_INTAKE_RETENTION_DAYS: "90",
};

const problemsOf = (env: Record<string, string>): string[] => {
  try {
    readConfig(env);
    return [];
  } catch (err) {
    return err instanceof ConfigError ? err.problems : [String(err)];
  }
};

afterEach(() => {
  delete process.env.AION_RUNTIME_MODE;
});

describe("runtime mode selection", () => {
  it("defaults to demo when nothing is set", () => {
    expect(readConfig({}).mode).toBe("demo");
    expect(readConfig({}).pilot).toBeNull();
  });

  it("refuses an unrecognised mode rather than guessing", () => {
    expect(() => readConfig({ AION_RUNTIME_MODE: "production" })).toThrow(ConfigError);
    // Case and surrounding whitespace are tolerated; the value itself is not guessed at.
    expect(readConfig({ AION_RUNTIME_MODE: " DEMO " }).mode).toBe("demo");
    expect(readConfig({ ...BASE_PILOT, AION_RUNTIME_MODE: "PILOT " }).mode).toBe("pilot");
  });

  it("refuses to run a demo with a database configured", () => {
    // The accident: a pilot DATABASE_URL left in a demo deployment's
    // environment. Starting would point the public demo at real records.
    const problems = problemsOf({ AION_RUNTIME_MODE: "demo", DATABASE_URL: "postgres://x/y" });
    expect(problems.join(" ")).toMatch(/DATABASE_URL is set but AION_RUNTIME_MODE=demo/);
  });

  it("accepts a fully configured pilot", () => {
    const cfg = readConfig(BASE_PILOT);
    expect(cfg.mode).toBe("pilot");
    expect(cfg.pilot!.databaseUrl).toContain("postgres://");
    expect(cfg.pilot!.photoRetentionDays).toBe(30);
    expect(cfg.pilot!.patientTokenTtlHours).toBe(72);
  });
});

describe("pilot mode fails closed", () => {
  it("requires every secret", () => {
    for (const key of ["DATABASE_URL", "AION_SESSION_SECRET", "AION_TOKEN_PEPPER"]) {
      const env = { ...BASE_PILOT };
      delete env[key];
      expect(problemsOf(env).join(" "), `${key} must be required`).toContain(key);
    }
  });

  it("rejects placeholder and short secrets", () => {
    expect(problemsOf({ ...BASE_PILOT, AION_SESSION_SECRET: "changeme" }).join(" ")).toMatch(/placeholder|32 char/);
    expect(problemsOf({ ...BASE_PILOT, AION_SESSION_SECRET: "short" }).join(" ")).toMatch(/at least 32/);
    expect(problemsOf({ ...BASE_PILOT, AION_TOKEN_PEPPER: "development" }).join(" ")).toMatch(/placeholder|32 char/);
  });

  it("refuses to reuse one secret for two purposes", () => {
    const same = "z".repeat(40);
    expect(
      problemsOf({ ...BASE_PILOT, AION_SESSION_SECRET: same, AION_TOKEN_PEPPER: same }).join(" "),
    ).toMatch(/must be different/);
  });

  it("requires a retention decision rather than inventing one", () => {
    const env = { ...BASE_PILOT };
    delete env.AION_PHOTO_RETENTION_DAYS;
    const problems = problemsOf(env).join(" ");
    expect(problems).toContain("AION_PHOTO_RETENTION_DAYS");
    // The message says why, because the next person will want to know whether
    // they can just put a number in.
    expect(problems).toMatch(/policy decision/);
    expect(problemsOf({ ...BASE_PILOT, AION_INTAKE_RETENTION_DAYS: "0" }).join(" ")).toMatch(/positive whole number/);
    expect(problemsOf({ ...BASE_PILOT, AION_INTAKE_RETENTION_DAYS: "forever" }).join(" ")).toMatch(/positive whole/);
  });

  it("requires a validly configured object store", () => {
    expect(problemsOf({ ...BASE_PILOT, AION_OBJECT_STORE: "" }).join(" ")).toMatch(/must be "local" or "s3"/);
    const noRoot = { ...BASE_PILOT };
    delete noRoot.AION_OBJECT_STORE_ROOT;
    expect(problemsOf(noRoot).join(" ")).toContain("AION_OBJECT_STORE_ROOT");
    expect(problemsOf({ ...BASE_PILOT, AION_OBJECT_STORE: "s3" }).join(" ")).toContain("AION_S3_BUCKET");
  });

  it("refuses to enable the demo reset endpoint in pilot mode", () => {
    expect(problemsOf({ ...BASE_PILOT, AION_ALLOW_DEMO_RESET: "1" }).join(" ")).toMatch(/not permitted in pilot/);
  });

  it("reports every problem at once rather than one per restart", () => {
    const problems = problemsOf({ AION_RUNTIME_MODE: "pilot" });
    expect(problems.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects a database url that is not postgres", () => {
    expect(problemsOf({ ...BASE_PILOT, DATABASE_URL: "mysql://x/y" }).join(" ")).toMatch(/must be a postgres/);
  });
});

describe("log field policy", () => {
  const safe = __testing.safeFields;

  it("keeps identifiers, counts and flags", () => {
    const out = safe({ request_id: "req_1", intake_id: "int_1", status: 200, urgent: true });
    expect(out).toEqual({ request_id: "req_1", intake_id: "int_1", status: 200, urgent: true });
  });

  it("drops any string field that is not an allowlisted identifier", () => {
    const out = safe({
      answer: "my rash has been itching for two weeks",
      patient_name: "Maya Ellison",
      hpi: "The patient reports...",
      note: "scratchpad",
      prompt: "You are an interviewer",
    });
    expect(out).toEqual({});
  });

  it("drops an allowlisted field carrying prose rather than an identifier", () => {
    // The allowlist is about which fields MAY carry a string, not a promise
    // that whatever arrives in one is safe.
    const out = safe({ reason: "the patient said their rash has been\nitching badly for weeks" });
    expect(out).toEqual({});
    expect(safe({ reason: "timeout" })).toEqual({ reason: "timeout" });
  });

  it("drops an over-long identifier", () => {
    expect(safe({ intake_id: "x".repeat(200) })).toEqual({});
  });
});

describe("request ids", () => {
  const reqWith = (id: string | null) =>
    ({ headers: { get: () => id } }) as unknown as Request;

  it("adopts a well-formed inbound id so a proxy's id survives", () => {
    expect(requestIdFrom(reqWith("abc123-DEF_456"))).toBe("abc123-DEF_456");
  });

  it("mints a fresh id when the inbound one is missing or hostile", () => {
    for (const bad of [null, "", "short", "has spaces", "x".repeat(200), "<script>alert(1)</script>"]) {
      const id = requestIdFrom(reqWith(bad));
      expect(id).not.toBe(bad);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

describe("audit meta policy", () => {
  it("keeps small non-clinical facts", () => {
    expect(sanitizeMeta({ photo_count: 2, urgent: true, pathway: "rash" })).toEqual({
      photo_count: 2,
      urgent: true,
      pathway: "rash",
    });
  });

  it("drops clinical content by field name and by length", () => {
    expect(
      sanitizeMeta({
        hpi_text: "The patient reports an itchy rash",
        patient_name: "Maya",
        answer: "two weeks",
        note_content: "scratchpad",
        summary: "a".repeat(200),
      }),
    ).toEqual({});
  });
});

describe("error taxonomy", () => {
  it("gives every code a status and a message with no internals", () => {
    for (const code of ERROR_CODES) {
      const spec = errorSpec(code);
      expect(spec.status).toBeGreaterThanOrEqual(400);
      expect(spec.message.length).toBeGreaterThan(8);
      expect(spec.message).not.toMatch(/postgres|sql|stack|undefined|null|Error:/i);
    }
  });

  it("never forwards an unrecognised error message to the client", () => {
    const leaky = new Error('relation "intakes" does not exist at postgres://user:hunter2@db:5432');
    const app = toAppError(leaky);
    expect(app.code).toBe("INTERNAL");
    expect(app.publicMessage).not.toContain("hunter2");
    expect(app.publicMessage).not.toContain("postgres");
    // The detail is kept for the log, where it is useful and not exposed.
    expect(app.detail).toContain("intakes");
  });

  it("classifies database conditions the caller can act on", () => {
    expect(toAppError(new Error("connect ECONNREFUSED 127.0.0.1:5432")).code).toBe("STORE_UNAVAILABLE");
    expect(toAppError(new Error("could not serialize access due to concurrent update")).code).toBe("STORE_CONFLICT");
    expect(toAppError(new Error("deadlock detected")).code).toBe("STORE_CONFLICT");
  });

  it("passes an AppError through unchanged", () => {
    const e = new AppError("INTAKE_EXPIRED", "token past ttl");
    expect(toAppError(e)).toBe(e);
    expect(e.status).toBe(410);
    expect(e.retryable).toBe(false);
  });
});
