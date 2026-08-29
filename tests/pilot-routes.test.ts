import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUTES, routeFor, type AuthClass } from "@/lib/routes";

/**
 * The route authorization matrix, kept honest.
 *
 * Route-level security fails by omission — twelve routes are guarded and the
 * thirteenth, added on a Friday, is not. So this walks the filesystem, finds
 * every route that actually exists, and fails if one is missing from the
 * matrix or declares an authorization class its source does not implement.
 * Adding a route without stating what protects it is a red build.
 */

const API_ROOT = join(process.cwd(), "src", "app", "api");

function findRoutes(dir: string, prefix = "/api"): Array<{ path: string; file: string }> {
  const out: Array<{ path: string; file: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...findRoutes(full, `${prefix}/${entry}`));
    } else if (entry === "route.ts") {
      out.push({ path: prefix, file: full });
    }
  }
  return out;
}

const discovered = findRoutes(API_ROOT);
const source = (file: string) => readFileSync(file, "utf8");
const methodsIn = (src: string) =>
  ["GET", "POST", "PATCH", "PUT", "DELETE"].filter((m) => new RegExp(`export async function ${m}\\b`).test(src));

describe("route inventory", () => {
  it("found the routes at all", () => {
    expect(discovered.length).toBeGreaterThanOrEqual(15);
  });

  it("every route on disk is declared in the matrix", () => {
    const undeclared = discovered.filter((r) => !routeFor(r.path)).map((r) => r.path);
    expect(
      undeclared,
      `These routes exist but have no entry in src/lib/routes.ts. Add one stating who may call them.`,
    ).toEqual([]);
  });

  it("every declared route exists on disk", () => {
    const paths = new Set(discovered.map((r) => r.path));
    const missing = ROUTES.filter((r) => !paths.has(r.path)).map((r) => r.path);
    expect(missing, "The matrix lists routes that no longer exist").toEqual([]);
  });

  it("declared methods match the handlers that are actually exported", () => {
    for (const r of discovered) {
      const spec = routeFor(r.path);
      if (!spec) continue;
      expect(methodsIn(source(r.file)).sort(), `${r.path} methods`).toEqual([...spec.methods].sort());
    }
  });
});

describe("each authorization class is actually implemented", () => {
  const srcFor = (path: string) => source(discovered.find((r) => r.path === path)!.file);

  const byClass = (cls: AuthClass) => ROUTES.filter((r) => r.auth === cls);

  it("clinician routes obtain a scope or a clinician context", () => {
    for (const r of byClass("clinician")) {
      const src = srcFor(r.path);
      const guarded =
        /clinicianScope|clinicianWriteScope|requireClinician/.test(src) ||
        // /api/metrics is gated in middleware alongside the clinician view;
        // the matcher below is asserted separately.
        r.path === "/api/metrics";
      expect(guarded, `${r.path} claims "clinician" but calls no clinician guard`).toBe(true);
    }
  });

  it("pilot-only routes refuse to run in demo mode", () => {
    for (const r of byClass("pilot-only")) {
      expect(/requirePilotMode\(\)/.test(srcFor(r.path)), `${r.path} must call requirePilotMode()`).toBe(true);
    }
  });

  it("demo-only routes refuse to run in pilot mode", () => {
    for (const r of byClass("demo-only")) {
      const src = srcFor(r.path);
      expect(/isPilot\(\)|requireDemoMode\(\)/.test(src), `${r.path} must refuse pilot mode`).toBe(true);
    }
  });

  it("patient routes resolve the token through the store rather than trusting it", () => {
    for (const r of byClass("patient")) {
      const src = srcFor(r.path);
      // Either the guard, or the demo-era bundleByToken lookup — both resolve
      // the token against the store rather than treating it as a claim.
      expect(
        /requirePatient|bundleByToken|resolveToken/.test(src),
        `${r.path} must resolve its token`,
      ).toBe(true);
    }
  });

  it("no route is public unless the matrix says so, with a reason", () => {
    for (const r of byClass("public")) {
      expect(r.note.length, `${r.path} is public and must say why`).toBeGreaterThan(30);
    }
    // The only public routes are the second factor itself (which cannot
    // require having passed it) and client analytics.
    expect(byClass("public").map((r) => r.path).sort()).toEqual([
      "/api/analytics",
      "/api/intake/[token]/verify",
    ]);
  });

  it("the middleware gate covers the clinician surface", () => {
    const mw = readFileSync(join(process.cwd(), "src", "middleware.ts"), "utf8");
    for (const pattern of ["/clinician/:path*", "/api/clinician/:path*", "/api/metrics"]) {
      expect(mw.includes(pattern), `middleware must match ${pattern}`).toBe(true);
    }
  });
});

describe("state-changing routes", () => {
  it("are the ones the matrix marks as writes", () => {
    for (const r of discovered) {
      const spec = routeFor(r.path);
      if (!spec) continue;
      const mutating = spec.methods.some((m) => m !== "GET");
      expect(spec.writes, `${r.path} writes flag`).toBe(mutating);
    }
  });

  it("clinician writes go through the CSRF-checking scope", () => {
    for (const r of ROUTES.filter((x) => x.auth === "clinician" && x.writes)) {
      const src = srcFor(r.path);
      expect(
        /clinicianWriteScope|requireCsrf|clinicianScope/.test(src),
        `${r.path} is a clinician write and must obtain a scope`,
      ).toBe(true);
    }
  });

  const srcFor = (path: string) => source(discovered.find((r) => r.path === path)!.file);
});

describe("security headers", () => {
  const cfg = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");

  it("sets the headers that matter and none that break voice or camera", () => {
    for (const header of [
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-Frame-Options",
      "Permissions-Policy",
      "Strict-Transport-Security",
    ]) {
      expect(cfg.includes(header), `missing ${header}`).toBe(true);
    }
    // The product needs the microphone for voice answers and the camera for
    // photographs; a policy that denied them would break the wedge.
    expect(cfg).toMatch(/camera=\(self\)/);
    expect(cfg).toMatch(/microphone=\(self\)/);
    expect(cfg).toMatch(/geolocation=\(\)/);
  });

  it("keeps a compromised page from posting patient answers elsewhere", () => {
    expect(cfg).toMatch(/connect-src 'self'/);
    expect(cfg).toMatch(/frame-ancestors 'none'/);
    expect(cfg).toMatch(/object-src 'none'/);
    // No inline script is shipped, so none is allowed. Read the script-src
    // directive on its own: in the source the directives are array elements,
    // so a looser pattern would match style-src's 'unsafe-inline' next door.
    const scriptSrc = cfg.match(/"(script-src[^"]*)"/)?.[1] ?? "";
    expect(scriptSrc, "script-src directive not found").not.toBe("");
    expect(scriptSrc).not.toContain("unsafe-inline");
  });

  it("does not advertise the runtime", () => {
    expect(cfg).toMatch(/poweredByHeader:\s*false/);
  });
});
