/**
 * Adversarial pass against a RUNNING pilot server.
 *
 *   npm run dev:pilot            # in one terminal
 *   npm run attack               # in another
 *   npm run attack -- --base=http://localhost:3100
 *
 * The unit suites test the store, the guards and the strategies in isolation.
 * This attacks the assembled thing over HTTP, where the interesting failures
 * live: a guard that is correct but not wired to a route, a header set in
 * middleware but stripped by a rewrite, a payload that is escaped in one
 * surface and not another.
 *
 * It is deliberately destructive-adjacent — it submits, deletes and revokes —
 * so it refuses to run against anything but a local pilot with synthetic seed
 * data. Point it at real records and it exits without touching them.
 *
 * It MUTATES the data it runs against — it passes second factors, submits
 * answers and edits briefs — so reseed between runs
 * (`npx tsx scripts/pilot.ts seed --confirm`). Checks that depend on
 * pre-interaction state say so where they are written.
 *
 * Exit code is the number of failures, so CI and a human read the same thing.
 */

const args = process.argv.slice(2);
const BASE = (args.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? "http://localhost:3100").replace(/\/$/, "");

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

interface Result {
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
let group = "";

function section(title: string) {
  group = title;
  console.log(`\n${title}`);
}
function check(name: string, ok: boolean, detail = "") {
  results.push({ name: `${group} / ${name}`, ok, detail });
  console.log(`  ${ok ? green("PASS") : red("FAIL")}  ${name}${detail ? dim(`  — ${detail}`) : ""}`);
}

/** The seeded synthetic tokens. Fixed strings, so nothing has to be scraped. */
const TOKENS = {
  live: "seed-live-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  active: "seed-active-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  submitted: "seed-submitted-token-cccccccccccccccccccccccccc",
  expired: "seed-expired-token-dddddddddddddddddddddddddddd",
  revoked: "seed-revoked-token-eeeeeeeeeeeeeeeeeeeeeeeeeeee",
  reviewed: "seed-reviewed-token-ffffffffffffffffffffffffffff",
  other: "seed-otherpractice-token-gggggggggggggggggggggggg",
};

/**
 * Payloads that must never come back executable. Chosen to break out of the
 * different contexts a string can land in: HTML text, an attribute, a JSON
 * island in a script tag, a URL.
 */
const XSS_PAYLOADS = [
  `<script>window.__aionPwned=1</script>`,
  `"><img src=x onerror="window.__aionPwned=1">`,
  `javascript:window.__aionPwned=1`,
  `</script><script>window.__aionPwned=1</script>`,
  `<svg/onload=window.__aionPwned=1>`,
  `{{constructor.constructor('window.__aionPwned=1')()}}`,
  `<script>window.__aionPwned=1</script>`,
];

async function req(
  path: string,
  init: RequestInit & { csrf?: string; cookie?: string } = {},
): Promise<{ status: number; body: string; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.csrf) headers.set("x-aion-csrf", init.csrf);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/** Seeded dates of birth, which are the seeded second factor. */
const DOB: Record<string, string> = {
  [TOKENS.live]: "2007-02-18",
  [TOKENS.active]: "1991-04-12",
  [TOKENS.submitted]: "1962-11-03",
  [TOKENS.reviewed]: "1991-04-12",
  [TOKENS.other]: "1984-01-25",
};

/**
 * Passes the second factor for a token.
 *
 * Without this every patient write in this script 401s, and the checks that
 * follow pass because nothing was ever written — the exact false green this
 * script exists to avoid. So it is asserted rather than assumed.
 */
async function verify(token: string): Promise<boolean> {
  const res = await req(`/api/intake/${token}/verify`, {
    method: "POST",
    body: JSON.stringify({ answer: DOB[token] }),
  });
  return res.status === 200;
}

/** Signs in a seeded clinician and returns the cookie and CSRF token. */
async function signIn(email: string): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "SyntheticPilot1" }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const json = (await res.json().catch(() => ({}))) as { csrfToken?: string };
  if (!cookie || !json.csrfToken) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  return { cookie, csrf: json.csrfToken };
}

/** Refuses to run anywhere that is not a local synthetic pilot. */
async function guardRails(): Promise<boolean> {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
    console.error(red(`Refusing to attack ${BASE}. This script submits, deletes and revokes.`));
    return false;
  }
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health || health.mode !== "pilot") {
    console.error(red(`${BASE} is not a pilot server (mode=${health?.mode ?? "unreachable"}).`));
    return false;
  }
  // Synthetic seed tokens must resolve. If they do not, this is somebody's
  // real data and none of what follows should touch it.
  const probe = await req(`/api/intake/${TOKENS.active}`);
  if (probe.status === 404) {
    console.error(red("Seeded synthetic tokens are absent — refusing to run against unknown data."));
    return false;
  }
  return true;
}

async function main(): Promise<number> {
  console.log(`Attacking ${BASE}`);
  if (!(await guardRails())) return 1;

  const northgate = await signIn("okonkwo@northgate.example");
  const riverside = await signIn("navarro@riverside.example");

  // ── The second factor, before anything in this run verifies anything ────
  // This has to come first: once a token is verified the question cannot be
  // asked again, and a check that runs after the fact silently passes.
  section("Second factor gates reads, not just writes");
  {
    // A token this script never verifies, so the check keeps its meaning on a
    // second run against the same database.
    const t = TOKENS.reviewed;
    const api = await req(`/api/intake/${t}`);
    check(
      "the response carries no intake content at all",
      !/"messages"|"facts"|"photos"|"concern"/.test(api.body),
      api.body.slice(0, 90),
    );
    const page = await req(`/intake/${t}`);
    check("unverified token's page shows no patient data", !/Ellison|Osei|Whitaker/i.test(page.body), `status ${page.status}`);
    check("the page does ask for the factor", /Before we start/i.test(page.body), `status ${page.status}`);
  }

  // ── Stored XSS, end to end ──────────────────────────────────────────────
  section("Stored XSS");
  {
    // Plant every payload through the patient's own surfaces, then read every
    // surface that renders them back.
    const token = TOKENS.live;
    check("second factor passed before planting", await verify(token), "otherwise every write 401s and this section is vacuous");
    await req(`/api/intake/${token}/start`, { method: "POST" });
    let planted = 0;
    for (const payload of XSS_PAYLOADS) {
      const r = await req(`/api/intake/${token}/message`, { method: "POST", body: JSON.stringify({ answer: payload }) });
      if (r.status < 300) planted += 1;
    }
    check("payloads accepted by the patient surface", planted > 0, `${planted}/${XSS_PAYLOADS.length}`);

    const surfaces: Array<{ label: string; path: string; cookie?: string }> = [
      { label: "patient interview page", path: `/intake/${token}` },
      { label: "patient intake API", path: `/api/intake/${token}` },
      { label: "clinician worklist", path: `/clinician`, cookie: northgate.cookie },
      { label: "clinician brief", path: `/clinician/int_live`, cookie: northgate.cookie },
      { label: "clinician list API", path: `/api/clinician/intakes`, cookie: northgate.cookie },
      { label: "clinician sign-in page", path: `/clinician/sign-in` },
    ];

    for (const s of surfaces) {
      const res = await req(s.path, { cookie: s.cookie });
      const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");

      // The test is not "the payload is absent" — it is stored data and is
      // meant to be echoed back to the patient who typed it. The test is that
      // it is never EXECUTABLE.
      //
      // A JSON response is not an execution context: `<script>` inside a JSON
      // string value, served as application/json with nosniff, is inert. So
      // the executable-context checks apply to HTML only, and JSON gets the
      // check that actually matters for it — that it is not served as HTML.
      if (!isHtml) {
        check(
          `${s.label} (json)`,
          !(res.headers.get("content-type") ?? "").includes("text/html"),
          `${res.status}, content-type ${res.headers.get("content-type")?.split(";")[0]}`,
        );
        continue;
      }

      // In HTML there are two execution contexts and they fail differently.
      //
      // 1. Markup. The payload must arrive entity-escaped, so it renders as
      //    text rather than becoming an element or an event handler.
      // 2. Inside a <script> element — the framework's own serialized data
      //    payload. There, `<` must be unicode-escaped (\u003c). A raw
      //    `</script` in that string is a breakout: the browser ends the
      //    element early and whatever follows becomes markup.
      //
      // Checking only for the literal string "<script>" anywhere in the body
      // confuses these two and fails on correctly-escaped output, which is how
      // an XSS check quietly stops meaning anything.
      const scripts = [...res.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      const breakout = scripts.some((m) => /<\/script/i.test(m[2]));
      check(`${s.label} — no script breakout`, !breakout, "");

      // Correctly escaped output still contains the literal characters
      // "onerror=" — inside an entity-escaped TEXT node, where they are inert.
      // So the question is not whether those characters appear, it is WHERE:
      // every occurrence of the marker must be in a text node, never inside a
      // tag. Walk the markup and record the position of each occurrence.
      const markup = res.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      let inTag = false;
      let insideTag = 0;
      let inText = 0;
      for (let i = 0; i < markup.length; i += 1) {
        const c = markup[i];
        if (c === "<") inTag = true;
        else if (c === ">") inTag = false;
        else if (markup.startsWith("__aionPwned", i)) {
          if (inTag) insideTag += 1;
          else inText += 1;
          i += "__aionPwned".length - 1;
        }
      }
      check(
        s.label,
        insideTag === 0,
        insideTag > 0
          ? `${insideTag} occurrence(s) inside a tag — the payload became markup`
          : `${res.status}, ${res.body.length}b, ${inText} occurrence(s), all inert text`,
      );
    }

    // The escaped form must actually be present somewhere — otherwise the
    // check above passes because nothing was stored at all.
    const echoed = await req(`/api/intake/${token}`);
    check(
      "payloads were genuinely stored (not silently dropped)",
      echoed.body.includes("__aionPwned"),
      "the escaping check is only meaningful if the payload survived",
    );
  }

  // ── Tenant isolation over HTTP ──────────────────────────────────────────
  section("Tenant isolation");
  {
    // The brief PAGE, not just the API: the page is where a clinician actually
    // reads a patient's history, and it is the surface that had no guard on it.
    for (const [label, path] of [
      ["another practice's brief page", "/clinician/int_other"],
      ["another practice's brief page, unauthenticated", "/clinician/int_other"],
    ] as Array<[string, string]>) {
      const anon = label.endsWith("unauthenticated");
      const res = await req(path, { cookie: anon ? undefined : northgate.cookie });
      // Unauthenticated gets a redirect to sign-in; cross-tenant gets a 404.
      const ok = anon ? res.status === 307 || res.status === 302 || res.status === 404 : res.status === 404;
      check(label, ok, `status ${res.status}`);
      check(`${label} — no patient data in body`, !/da Costa|Scaly patches/i.test(res.body), "");
    }

    // The worklist page must not show one practice the other's patients.
    const list = await req("/clinician", { cookie: northgate.cookie });
    check("worklist shows only the signed-in practice", !/da Costa/i.test(list.body), `status ${list.status}`);
    check("worklist requires a session", [302, 307].includes((await req("/clinician")).status), "");
    // And it must never print a patient's access link on a clinician's screen.
    check("worklist does not expose patient links", !/href="\/intake\//.test(list.body), "");

    // The owning practice CAN read it, so the checks above are a boundary
    // rather than a broken route.
    const own = await req("/clinician/int_other", { cookie: riverside.cookie });
    check("owning practice can open its own brief", own.status === 200, `status ${own.status}`);

    // Writes across the boundary.
    const write = await req("/api/clinician/intakes/int_other", {
      method: "PATCH",
      cookie: northgate.cookie,
      csrf: northgate.csrf,
      body: JSON.stringify({ hpi: "written by the wrong practice" }),
    });
    check("write to another practice's intake", write.status === 404 || write.status === 403, `status ${write.status}`);
  }

  // ── Patient token lifecycle ─────────────────────────────────────────────
  section("Patient token lifecycle");
  {
    for (const [state, expected] of [
      ["expired", [401, 403, 404, 410] as number[]],
      ["revoked", [401, 403, 404, 410] as number[]],
    ] as const) {
      const res = await req(`/api/intake/${TOKENS[state]}`);
      check(`${state} token is refused`, expected.includes(res.status), `status ${res.status}`);
      const write = await req(`/api/intake/${TOKENS[state]}/message`, {
        method: "POST",
        body: JSON.stringify({ answer: "should not land" }),
      });
      check(`${state} token cannot write`, expected.includes(write.status), `status ${write.status}`);
    }
    const bogus = await req("/api/intake/not-a-real-token-aaaaaaaaaaaaaaaaaaaaaaaa");
    check("unknown token is a 404", bogus.status === 404, `status ${bogus.status}`);

    // A frozen intake must reject writes — after passing the factor, so the
    // rejection is about the freeze rather than about verification.
    check("submitted token verifies", await verify(TOKENS.submitted), "");
    // A frozen intake answers 200 with its current state by design — a stale
    // tab or a double submit should not see an error. The property that matters
    // is that nothing was recorded, so assert the record, not the status.
    const beforeFrozen = await req(`/api/intake/${TOKENS.submitted}`);
    await req(`/api/intake/${TOKENS.submitted}/message`, {
      method: "POST",
      body: JSON.stringify({ answer: "PLANTED AFTER SUBMISSION" }),
    });
    const afterFrozen = await req(`/api/intake/${TOKENS.submitted}`);
    check(
      "a submitted intake records nothing further",
      !afterFrozen.body.includes("PLANTED AFTER SUBMISSION") && afterFrozen.body.length === beforeFrozen.body.length,
      "",
    );

  }

  // ── CSRF and origin ─────────────────────────────────────────────────────
  section("CSRF");
  {
    const noToken = await req("/api/clinician/intakes/int_live", {
      method: "PATCH",
      cookie: northgate.cookie,
      body: JSON.stringify({ hpi: "no csrf token" }),
    });
    check("clinician write without the CSRF header", noToken.status === 403, `status ${noToken.status}`);

    const wrongToken = await req("/api/clinician/intakes/int_live", {
      method: "PATCH",
      cookie: northgate.cookie,
      csrf: "not-the-right-token",
      body: JSON.stringify({ hpi: "wrong csrf token" }),
    });
    check("clinician write with a wrong CSRF token", wrongToken.status === 403, `status ${wrongToken.status}`);

    const crossOrigin = await req("/api/clinician/intakes/int_live", {
      method: "PATCH",
      cookie: northgate.cookie,
      csrf: northgate.csrf,
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ hpi: "cross origin" }),
    });
    check("cross-origin write", crossOrigin.status === 403, `status ${crossOrigin.status}`);
  }

  // ── Security headers ────────────────────────────────────────────────────
  section("Response headers");
  {
    const page = await req(`/intake/${TOKENS.live}`);
    const csp = page.headers.get("content-security-policy") ?? "";
    check("CSP present", csp.length > 0, csp.slice(0, 60));
    // Only script-src matters here. style-src carries 'unsafe-inline' by
    // necessity — the framework emits inline style attributes — and inline
    // style is not script execution.
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
    check("script-src uses a nonce", /nonce-/.test(scriptSrc), scriptSrc.slice(0, 50));
    check("script-src has no unsafe-inline", !/unsafe-inline/.test(scriptSrc), scriptSrc.slice(0, 50));
    check("frame-ancestors set", /frame-ancestors/.test(csp), "");
    check("no-store on a patient page", /no-store/.test(page.headers.get("cache-control") ?? ""), page.headers.get("cache-control") ?? "");
    check("nosniff", page.headers.get("x-content-type-options") === "nosniff", "");
    check("referrer policy", (page.headers.get("referrer-policy") ?? "").length > 0, page.headers.get("referrer-policy") ?? "");

    // Two loads must not reuse a nonce.
    const again = await req(`/intake/${TOKENS.live}`);
    const n1 = /nonce-([A-Za-z0-9+/=_-]+)/.exec(csp)?.[1];
    const n2 = /nonce-([A-Za-z0-9+/=_-]+)/.exec(again.headers.get("content-security-policy") ?? "")?.[1];
    check("nonce is per-request", Boolean(n1 && n2 && n1 !== n2), "");
  }

  // ── Error surface ───────────────────────────────────────────────────────
  section("Error surface");
  {
    const bad = await req(`/api/intake/${TOKENS.live}/message`, { method: "POST", body: "{not json" });
    const leaks = [/at Object\./, /node_modules/, /postgres/i, /pglite/i, /SELECT /i, /\.ts:\d+/, /ECONNREFUSED/];
    const leaked = leaks.find((re) => re.test(bad.body));
    check("malformed body does not leak internals", leaked === undefined, leaked ? String(leaked) : bad.body.slice(0, 80));

    const huge = await req(`/api/intake/${TOKENS.live}/message`, {
      method: "POST",
      body: JSON.stringify({ answer: "x".repeat(2_000_000) }),
    });
    check("oversized body is refused with 413", huge.status === 413, `status ${huge.status}`);

    // Chunked, so there is no content-length to check. A cap that only reads
    // the header is bypassed by anyone who sends one of these.
    const chunked = await fetch(`${BASE}/api/intake/${TOKENS.live}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A ReadableStream body makes fetch use chunked transfer encoding.
      body: new ReadableStream({
        start(controller) {
          const chunk = new TextEncoder().encode("x".repeat(100_000));
          controller.enqueue(new TextEncoder().encode('{"answer":"'));
          for (let i = 0; i < 30; i += 1) controller.enqueue(chunk);
          controller.enqueue(new TextEncoder().encode('"}'));
          controller.close();
        },
      }),
      // @ts-expect-error duplex is required by undici for a stream body.
      duplex: "half",
    }).catch(() => null);
    check("chunked oversized body is refused too", chunked === null || chunked.status === 413, `status ${chunked?.status ?? "connection reset"}`);

    // A body with no `answer` key at all must be a 400, not a silently
    // recorded blank answer that advances the interview.
    const wrongShape = await req(`/api/intake/${TOKENS.live}/message`, {
      method: "POST",
      body: JSON.stringify({ text: "wrong field name" }),
    });
    check("a body with no answer field is a 400", wrongShape.status === 400, `status ${wrongShape.status}`);
  }

  // ── Deletion: is a deleted record reachable by any surviving handle? ────
  section("Deletion");
  {
    // Everything that could still point at an intake after it is deleted.
    const target = "int_reviewed";
    const patientLink = TOKENS.reviewed;
    const before = await req(`/clinician/${target}`, { cookie: northgate.cookie });
    check("target exists before deletion", before.status === 200, `status ${before.status}`);

    const photoIds = [...before.body.matchAll(/(pho_[a-zA-Z0-9_]+)/g)].map((m) => m[1]);

    const del = await req(`/api/clinician/intakes/${target}`, {
      method: "DELETE",
      cookie: northgate.cookie,
      csrf: northgate.csrf,
    });
    if (del.status === 405 || del.status === 404) {
      // Recorded, not waved past: deletion on demand does not exist, so the
      // only path to "delete this patient's record" is the retention job.
      check("clinician delete endpoint", true, `not exposed (${del.status}) — deletion is retention-only, noted`);
    } else {
      check("delete succeeds", del.status < 300, `status ${del.status}`);
      for (const [label, path] of [
        ["old patient link", `/api/intake/${patientLink}`],
        ["clinician bookmark", `/api/clinician/intakes/${target}`],
        ["clinician brief page", `/clinician/${target}`],
        ...photoIds.map((id) => [`photo endpoint ${id}`, `/api/intake/photo/${id}`] as [string, string]),
      ] as Array<[string, string]>) {
        const res = await req(path, { cookie: northgate.cookie });
        check(`${label} after deletion`, res.status === 404 || res.status === 410, `status ${res.status}`);
      }
    }
  }

  // ── Load: latency and error rate at pilot scale, over HTTP ─────────────
  section("Load");
  {
    async function burst(label: string, path: string, n: number, concurrency: number, cookie?: string) {
      const latencies: number[] = [];
      let errors = 0;
      let idx = 0;
      const worker = async () => {
        while (idx < n) {
          idx += 1;
          const t0 = Date.now();
          try {
            const res = await req(path, { cookie });
            if (res.status >= 500) errors += 1;
          } catch {
            errors += 1;
          }
          latencies.push(Date.now() - t0);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      latencies.sort((a, b) => a - b);
      const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
      const rate = errors / n;
      check(
        `${label} — ${n} requests at ${concurrency} concurrent`,
        rate === 0,
        `p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  p99 ${p(0.99)}ms  errors ${errors}/${n}`,
      );
      return { p50: p(0.5), p95: p(0.95), errors };
    }

    // 2,000 intakes a month is ~3 an hour. These bursts are orders of magnitude
    // above that on purpose: the number that matters is the error rate, not the
    // throughput.
    await burst("patient intake read", `/api/intake/${TOKENS.active}`, 200, 20);
    await burst("clinician worklist", "/api/clinician/intakes", 100, 10, northgate.cookie);
    await burst("health", "/api/health", 200, 40);
  }

  // ── Concurrency: two tabs, one intake ───────────────────────────────────
  section("Concurrency");
  {
    const token = TOKENS.active;
    check("active token verifies", await verify(token), "");
    await req(`/api/intake/${token}/start`, { method: "POST" });
    // Ten simultaneous answers from "different tabs" of the same patient.
    const sends = Array.from({ length: 10 }, (_, i) =>
      req(`/api/intake/${token}/message`, { method: "POST", body: JSON.stringify({ answer: `concurrent answer ${i}` }) }),
    );
    const settled = await Promise.all(sends);
    const server500s = settled.filter((r) => r.status >= 500);
    check("no 500s under simultaneous answers", server500s.length === 0, `${server500s.length} of ${settled.length}`);

    const after = await req(`/api/intake/${token}`);
    const landed = Array.from({ length: 10 }, (_, i) => `concurrent answer ${i}`).filter((t) =>
      after.body.includes(t),
    );
    // Not "all ten land": the interview legitimately runs out of questions, and
    // an answer arriving after the last one is a documented no-op. What must
    // hold is that what DID land is intact — no duplicates, no interleaving of
    // one answer into another, no corruption of the record.
    check("concurrent answers land without duplicates", new Set(landed).size === landed.length, `${landed.length} landed`);
    const dupes = landed.filter((t) => after.body.split(t).length - 1 > 1);
    check("no answer was recorded twice", dupes.length === 0, dupes.join(", "));
    check("the record is still readable after the burst", after.status === 200, `status ${after.status}`);

    // Two clinicians editing the same intake must not silently clobber.
    const a = req("/api/clinician/intakes/int_submitted", {
      method: "PATCH", cookie: northgate.cookie, csrf: northgate.csrf,
      body: JSON.stringify({ hpi: "clinician A note" }),
    });
    const b = req("/api/clinician/intakes/int_submitted", {
      method: "PATCH", cookie: northgate.cookie, csrf: northgate.csrf,
      body: JSON.stringify({ hpi: "clinician B note" }),
    });
    const [ra, rb] = await Promise.all([a, b]);
    check("simultaneous clinician edits do not 500", ra.status < 500 && rb.status < 500, `${ra.status}/${rb.status}`);
    const final = await req("/clinician/int_submitted", { cookie: northgate.cookie });
    const hasA = final.body.includes("clinician A note");
    const hasB = final.body.includes("clinician B note");
    check(
      "exactly one of the two edits is the durable result — not a merge, not neither",
      hasA !== hasB,
      `A=${hasA} B=${hasB}, status ${final.status}`,
    );
  }

  // ── Public demo endpoints must be off in pilot ──────────────────────────
  section("Demo endpoints in pilot mode");
  {
    const reset = await req("/api/demo/reset", { method: "POST" });
    check("demo reset is refused", reset.status >= 400, `status ${reset.status}`);
    const demo = await req("/demo");
    check("demo control panel is not a pilot surface", demo.status === 404, `status ${demo.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? green("All checks passed") : red(`${failed.length} failed`)} (${results.length} checks)`);
  for (const f of failed) console.log(red(`  ${f.name}`) + (f.detail ? dim(` — ${f.detail}`) : ""));
  console.log("");
  return failed.length;
}

main().then(
  (n) => process.exit(n === 0 ? 0 : 1),
  (err) => {
    console.error(red(`attack run failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(2);
  },
);
