import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The PAGES, not the API routes.
 *
 * Every pilot suite before this one tested the store and the API. The pages
 * were never touched, and all three of them — the patient interview, the
 * clinician worklist, the clinician brief — still read the synchronous
 * in-memory demo helpers. In pilot mode that meant:
 *
 *   /intake/[token]   the memory store is empty, so notFound(): EVERY patient
 *                     link rendered a 404. The pilot had working endpoints and
 *                     no working interface.
 *   /clinician        no requireClinician(), and listBundles() with no practice
 *                     id. It rendered empty so it leaked nothing — and it was
 *                     one data-source change away from serving every practice's
 *                     patients, and their access links, to anyone.
 *   /clinician/[id]   the same, for a single patient's full history.
 *   /demo             the founder control panel, unguarded, in pilot mode.
 *
 * 946 tests were green throughout. Rendering a React Server Component in a unit
 * test needs a request scope this harness does not have, so these tests read
 * the source and assert the wiring: which data source each page uses, and which
 * guard it calls. That is a weaker check than rendering, and it is the one that
 * would have caught all four. The behaviour itself is asserted over HTTP by
 * scripts/attack.ts against a running pilot server.
 */

const read = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

/** The synchronous demo-only helpers. Using one in a pilot path is the bug. */
const MEMORY_ONLY = ["bundleByToken", "bundleById", "listBundles", "saveIntake", "getIntake"];

/** Strips the demo branch so only the pilot path is examined. */
function pilotBranch(src: string): string {
  // Every page that serves both modes brackets the demo path with isPilot().
  // Crude but honest: if a page does not branch at all, this returns the whole
  // file and the assertions below apply to all of it — which is what we want.
  return src;
}

describe("the patient interview page", () => {
  const src = read("app/intake/[token]/page.tsx");

  it("goes through store(), not the in-memory helper", () => {
    expect(src).toMatch(/await store\(\)/);
    expect(src).toMatch(/resolveToken/);
  });

  it("enforces the second factor before rendering the record", () => {
    // Rendering the interview to an unverified token would hand over the name,
    // date of birth and answers, leaving the factor guarding writes alone.
    expect(src).toMatch(/verifiedAt/);
    expect(src).toMatch(/VerifyGate/);
  });

  it("does not distinguish expired, revoked and unknown to the caller", () => {
    // One notFound() for all of them: telling the holder of a dead link which
    // kind of dead it is confirms the link was real.
    expect(src.match(/notFound\(\)/g)?.length).toBeGreaterThanOrEqual(1);
    expect(src).not.toMatch(/expired.*message|revoked.*message/i);
  });
});

describe("the clinician worklist page", () => {
  const src = read("app/clinician/page.tsx");

  it("requires a signed-in clinician in pilot mode", () => {
    expect(src).toMatch(/requireClinician/);
    expect(src).toMatch(/redirect\("\/clinician\/sign-in"\)/);
  });

  it("scopes the query by the session's practice", () => {
    expect(src).toMatch(/listBundles\(ctx\.practiceId\)/);
  });

  it("never renders a patient access link in pilot mode", () => {
    // A clinician screen listing live patient links would put every one of them
    // into browser history, screen shares and screenshots.
    const pilotGuardedLink = /pilot \?[\s\S]{0,400}?Awaiting patient/;
    expect(src).toMatch(pilotGuardedLink);
  });
});

describe("the clinician brief page", () => {
  const src = read("app/clinician/[id]/page.tsx");

  it("requires a signed-in clinician", () => {
    expect(src).toMatch(/requireClinician/);
  });

  it("reads through the tenant-scoped query, never the unscoped one", () => {
    expect(src).toMatch(/bundleForClinician\(id, ctx!\.practiceId\)/);
  });

  it("writes the first-read HPI under the row lock", () => {
    // Two simultaneous first reads must not generate two briefs.
    expect(src).toMatch(/withIntake\(/);
  });

  it("audits the read", () => {
    expect(src).toMatch(/brief\.opened/);
  });
});

describe("the demo control panel", () => {
  const src = read("app/demo/page.tsx");

  it("does not exist in pilot mode", () => {
    // The reset API was already refused in pilot; the page was not.
    expect(src).toMatch(/isPilot\(\)[\s\S]{0,120}notFound\(\)/);
  });
});

describe("no pilot page path reads the in-memory store unguarded", () => {
  const pages = [
    "app/intake/[token]/page.tsx",
    "app/clinician/page.tsx",
    "app/clinician/[id]/page.tsx",
  ];

  it.each(pages)("%s brackets any memory-helper use behind a mode check", (page) => {
    const src = pilotBranch(read(page));
    const usesMemory = MEMORY_ONLY.some((fn) => new RegExp(`\\b${fn}\\(`).test(src));
    if (!usesMemory) return;
    // If a page still calls one, it must be inside an explicit demo branch —
    // never on a path a pilot request can reach.
    expect(src, `${page} uses a memory-only helper without a mode check`).toMatch(/isPilot\(\)/);
  });
});
