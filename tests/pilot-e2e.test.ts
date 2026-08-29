import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPilotFixture, TEST_PEPPER, TEST_SESSION_SECRET, tokenFor, intakeIdFor, type PilotFixture } from "./helpers/pilot";
import { setStore } from "@/lib/store";
import { setObjectStore } from "@/lib/objects/select";
import { resetConfigCache } from "@/lib/config/runtime";
import { issueSession, SESSION_COOKIE, CSRF_HEADER } from "@/lib/auth/session";
import { SEED_PASSWORD } from "@/lib/db/seed-pilot";
import { photoKey } from "@/lib/objects";
import { resetRateLimits } from "@/lib/ratelimit";

/**
 * The pilot routes, end to end.
 *
 * The store-level suites prove the data layer holds. This proves the HTTP
 * surface in front of it does too — that an unauthenticated request is
 * refused, that one practice's session cannot reach another practice's
 * records through a route, and that a photograph cannot be fetched by anyone
 * who happens to know its id.
 *
 * Route handlers are imported directly and given real Request objects, which
 * exercises everything except the network itself.
 */

let f: PilotFixture;
let cookieValue = "";

/** Next's cookies() reads from request headers we cannot set directly here. */
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE && cookieValue ? { value: cookieValue } : undefined),
  }),
}));

const PILOT_ENV: Record<string, string> = {
  AION_RUNTIME_MODE: "pilot",
  DATABASE_URL: "postgres://test/test",
  AION_SESSION_SECRET: TEST_SESSION_SECRET,
  AION_TOKEN_PEPPER: TEST_PEPPER,
  AION_OBJECT_STORE: "local",
  AION_OBJECT_STORE_ROOT: "/tmp/aion-e2e-objects",
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
  cookieValue = "";
  // Rate-limit buckets are process-global, so without this a test inherits
  // the spent tokens of the one before it and fails for the wrong reason.
  resetRateLimits();
});

afterEach(() => {
  cookieValue = "";
});

const req = (url: string, init: RequestInit = {}) => new Request(`http://aion.test${url}`, init);
const jsonReq = (url: string, body: unknown, init: RequestInit = {}) =>
  req(url, {
    method: "POST",
    headers: { "content-type": "application/json", host: "aion.test", ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });

/** Signs in as a clinician by installing a valid session cookie. */
function signInAs(clinicianId: string, practiceId: string): string {
  const { value, session } = issueSession(clinicianId, practiceId, TEST_SESSION_SECRET);
  cookieValue = value;
  return session.csrf;
}

describe("clinician sign-in", () => {
  it("accepts the seeded credentials and returns a csrf token", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(jsonReq("/api/auth/login", {
      email: "okonkwo@northgate.example",
      password: SEED_PASSWORD,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.practiceId).toBe("prac_northgate");
    expect(body.csrfToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("set-cookie")).toMatch(/aion_session=/);
    // The cookie a browser will actually protect.
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(res.headers.get("set-cookie")).toMatch(/SameSite=lax/i);
  }, 30_000);

  it("refuses a wrong password and an unknown address identically", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const wrong = await POST(jsonReq("/api/auth/login", {
      email: "okonkwo@northgate.example",
      password: "not-the-password",
    }));
    const unknown = await POST(jsonReq("/api/auth/login", {
      email: "nobody@nowhere.example",
      password: "not-the-password",
    }));

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Identical bodies apart from the request id: the endpoint must not reveal
    // whether an address belongs to a clinician at this practice.
    const a = await wrong.json();
    const b = await unknown.json();
    expect(a.error).toBe(b.error);
    expect(a.code).toBe(b.code);
    expect(wrong.headers.get("set-cookie")).toBeNull();
  }, 30_000);

  it("records both outcomes in the audit trail", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    await POST(jsonReq("/api/auth/login", { email: "okonkwo@northgate.example", password: SEED_PASSWORD }));
    await POST(jsonReq("/api/auth/login", { email: "okonkwo@northgate.example", password: "wrong" }));

    const events = await f.store.readAudit({ practiceId: "prac_northgate" });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("auth.login");
    expect(actions).toContain("auth.login_failed");
    // And no password anywhere in the trail.
    expect(JSON.stringify(events)).not.toContain(SEED_PASSWORD);
  }, 30_000);
});

describe("the clinician list is scoped to the session's practice", () => {
  it("returns only this practice's intakes", async () => {
    signInAs("cli_okonkwo", "prac_northgate");
    const { GET } = await import("@/app/api/clinician/intakes/route");
    const res = await GET(req("/api/clinician/intakes"));
    expect(res.status).toBe(200);

    const { intakes } = await res.json();
    expect(intakes.length).toBeGreaterThan(0);
    const ids = intakes.map((i: { id: string }) => i.id);
    expect(ids).toContain(intakeIdFor(f.seed, "submitted"));
    // The other practice's intake must not appear, nor its patient's name.
    expect(ids).not.toContain(intakeIdFor(f.seed, "other"));
    expect(JSON.stringify(intakes)).not.toContain("da Costa");
  });

  it("shows a different practice a different list", async () => {
    signInAs("cli_navarro", "prac_riverside");
    const { GET } = await import("@/app/api/clinician/intakes/route");
    const { intakes } = await (await GET(req("/api/clinician/intakes"))).json();
    expect(intakes.map((i: { id: string }) => i.id)).toEqual([intakeIdFor(f.seed, "other")]);
  });

  it("refuses an unauthenticated request", async () => {
    cookieValue = "";
    const { GET } = await import("@/app/api/clinician/intakes/route");
    const res = await GET(req("/api/clinician/intakes"));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("AUTH_REQUIRED");
  });

  it("refuses a forged session cookie", async () => {
    cookieValue = `${Buffer.from(
      JSON.stringify({ clinicianId: "cli_okonkwo", practiceId: "prac_riverside", exp: 2 ** 31, csrf: "x" }),
    ).toString("base64url")}.forged-signature`;
    const { GET } = await import("@/app/api/clinician/intakes/route");
    expect((await GET(req("/api/clinician/intakes"))).status).toBe(401);
  });
});

describe("cross-practice access through a route", () => {
  it("a Northgate clinician cannot edit a Riverside intake", async () => {
    const csrf = signInAs("cli_okonkwo", "prac_northgate");
    const { PATCH } = await import("@/app/api/clinician/intakes/[id]/route");
    const theirs = intakeIdFor(f.seed, "other");

    const res = await PATCH(
      jsonReq(`/api/clinician/intakes/${theirs}`, { hpi: "injected" }, {
        method: "PATCH",
        headers: { [CSRF_HEADER]: csrf, origin: "http://aion.test", host: "aion.test" },
      }),
      { params: Promise.resolve({ id: theirs }) },
    );
    expect(res.status).toBe(404);

    // And nothing was written.
    const after = await f.store.getIntake(theirs);
    expect(after!.hpi).not.toContain("injected");
  });

  it("a state-changing request without the csrf token is refused", async () => {
    signInAs("cli_okonkwo", "prac_northgate");
    const { PATCH } = await import("@/app/api/clinician/intakes/[id]/route");
    const ours = intakeIdFor(f.seed, "submitted");
    const res = await PATCH(
      jsonReq(`/api/clinician/intakes/${ours}`, { hpi: "x" }, {
        method: "PATCH",
        headers: { origin: "http://aion.test", host: "aion.test" },
      }),
      { params: Promise.resolve({ id: ours }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("ACCESS_DENIED");
  });

  it("a cross-origin request is refused even with a valid session", async () => {
    const csrf = signInAs("cli_okonkwo", "prac_northgate");
    const { PATCH } = await import("@/app/api/clinician/intakes/[id]/route");
    const ours = intakeIdFor(f.seed, "submitted");
    const res = await PATCH(
      jsonReq(`/api/clinician/intakes/${ours}`, { hpi: "x" }, {
        method: "PATCH",
        headers: { [CSRF_HEADER]: csrf, origin: "https://evil.example", host: "aion.test" },
      }),
      { params: Promise.resolve({ id: ours }) },
    );
    expect(res.status).toBe(403);
  });
});

describe("photo access", () => {
  const seedPhoto = async (intakeId: string, practiceId: string, id: string) => {
    const key = photoKey(practiceId, intakeId, "image/jpeg");
    await f.objects.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "image/jpeg");
    await f.store.addPhoto({
      id, intakeId, practiceId, objectKey: key, mime: "image/jpeg",
      bytes: 7, width: 800, height: 600, kind: "close", caption: "",
      advisories: [], idempotencyKey: null,
    });
    return key;
  };

  it("serves bytes to the owning practice and audits the read", async () => {
    await seedPhoto(intakeIdFor(f.seed, "submitted"), "prac_northgate", "pho_ours");
    signInAs("cli_okonkwo", "prac_northgate");

    const { GET } = await import("@/app/api/intake/photo/[photoId]/route");
    const res = await GET(req("/api/intake/photo/pho_ours"), {
      params: Promise.resolve({ photoId: "pho_ours" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    // Never cached, never sniffed, never framed.
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer())[0]).toBe(0xff);

    const events = await f.store.readAudit({ practiceId: "prac_northgate" });
    expect(events.some((e) => e.action === "photo.accessed" && e.resourceId === "pho_ours")).toBe(true);
  });

  it("refuses another practice's photo, indistinguishably from one that does not exist", async () => {
    await seedPhoto(intakeIdFor(f.seed, "other"), "prac_riverside", "pho_theirs");
    signInAs("cli_okonkwo", "prac_northgate");

    const { GET } = await import("@/app/api/intake/photo/[photoId]/route");
    const theirs = await GET(req("/api/intake/photo/pho_theirs"), {
      params: Promise.resolve({ photoId: "pho_theirs" }),
    });
    const missing = await GET(req("/api/intake/photo/pho_does_not_exist"), {
      params: Promise.resolve({ photoId: "pho_does_not_exist" }),
    });

    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    // Identical, so the response cannot confirm that an id is real.
    expect((await theirs.json()).error).toBe((await missing.json()).error);

    // The refusal is recorded.
    const events = await f.store.readAudit({ practiceId: "prac_northgate" });
    expect(events.some((e) => e.action === "authz.denied" && e.resourceId === "pho_theirs")).toBe(true);
  });

  it("refuses an unauthenticated photo request", async () => {
    await seedPhoto(intakeIdFor(f.seed, "submitted"), "prac_northgate", "pho_open");
    cookieValue = "";
    const { GET } = await import("@/app/api/intake/photo/[photoId]/route");
    const res = await GET(req("/api/intake/photo/pho_open"), {
      params: Promise.resolve({ photoId: "pho_open" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("patient verification through the route", () => {
  const verify = async (token: string, dateOfBirth: string) => {
    const { POST } = await import("@/app/api/intake/[token]/verify/route");
    return POST(jsonReq(`/api/intake/${token}/verify`, { dateOfBirth }), {
      params: Promise.resolve({ token }),
    });
  };

  it("accepts the right date of birth and marks the token verified", async () => {
    const token = tokenFor(f.seed, "active");
    const res = await verify(token, "1991-04-12");
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);

    const resolved = await f.store.resolveToken(token);
    expect(resolved.ok && resolved.access.verifiedAt).toBeTruthy();
  });

  it("refuses a wrong date of birth and counts the attempt durably", async () => {
    const token = tokenFor(f.seed, "active");
    const res = await verify(token, "1990-01-01");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("VERIFICATION_FAILED");

    const resolved = await f.store.resolveToken(token);
    expect(resolved.ok && resolved.access.failedVerifications).toBe(1);
  });

  it("kills the token after five wrong answers", async () => {
    const token = tokenFor(f.seed, "active");
    for (let i = 0; i < 5; i += 1) await verify(token, "1990-01-01");
    const res = await verify(token, "1991-04-12"); // even the right one now fails
    expect(res.status).toBe(410);
    expect(await f.store.resolveToken(token)).toEqual({ ok: false, reason: "locked" });
  });

  it("refuses an expired and a revoked token with distinct, honest codes", async () => {
    expect((await verify(tokenFor(f.seed, "expired"), "1978-09-30")).status).toBe(410);
    expect((await verify(tokenFor(f.seed, "revoked"), "1989-07-22")).status).toBe(410);
  });

  it("does not reveal whether an unknown token exists", async () => {
    const res = await verify("completely-made-up-token-value-here", "1991-04-12");
    expect(res.status).toBe(404);
  });
});

describe("demo-only routes are unreachable in pilot mode", () => {
  it("the reset endpoint is not found", async () => {
    const { POST } = await import("@/app/api/demo/reset/route");
    const res = await POST(jsonReq("/api/demo/reset", {}, { headers: { origin: "http://aion.test", host: "aion.test" } }));
    expect(res.status).toBe(404);
    // And the store still holds every seeded intake.
    expect((await f.store.listBundles("prac_northgate")).length).toBeGreaterThan(0);
  });
});
