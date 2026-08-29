import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs: the content security policy, and the demo's clinician gate.
 *
 * The CSP is issued here rather than in next.config because it carries a
 * per-request nonce. Next's App Router emits inline bootstrap scripts (the RSC
 * payload), so a policy without either a nonce or 'unsafe-inline' blocks
 * hydration and the app silently stops being interactive — which is what
 * happened the first time this was set in static headers, and what the browser
 * QA suite caught. A nonce keeps the strong policy: inline scripts run only if
 * the server put them there.
 *
 * Everything except script-src is duplicated from next.config's static headers
 * deliberately: static headers still cover responses that never reach
 * middleware (some static assets), so both must be right.
 */

const STATIC_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "upgrade-insecure-requests",
];

function cspWithNonce(nonce: string): string {
  // 'strict-dynamic' lets a nonced bootstrap load the chunks it needs without
  // enumerating them; 'unsafe-eval' is required by the Next runtime.
  return [
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval' 'self'`,
    ...STATIC_CSP,
  ].join("; ");
}

/**
 * Clinician access gate.
 *
 * A shared passphrase is not real authentication and is not claimed to be. It
 * exists so a public demo containing synthetic clinical-looking content is not
 * simply open to the internet. Set CLINICIAN_ACCESS_CODE to enable it; leave it
 * unset and the demo stays open. SECURITY.md sets out what has to replace this
 * before any real patient information exists.
 */
const COOKIE = "aion_clinician";

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = cspWithNonce(nonce);

  /**
   * Next reads the nonce back out of the request's CSP header and stamps it on
   * the scripts it emits, so the header has to go out on the request as well as
   * on the response.
   */
  const withNonce = (res: NextResponse): NextResponse => {
    res.headers.set("content-security-policy", csp);
    return res;
  };
  const forward = () => {
    const headers = new Headers(req.headers);
    headers.set("x-nonce", nonce);
    headers.set("content-security-policy", csp);
    return withNonce(NextResponse.next({ request: { headers } }));
  };

  const code = process.env.CLINICIAN_ACCESS_CODE;
  const gated = /^\/(clinician|api\/clinician|api\/metrics)/.test(req.nextUrl.pathname);
  if (!code || !gated) return forward();

  const url = req.nextUrl;
  const supplied = url.searchParams.get("code");
  if (supplied && timingSafeEqual(supplied, code)) {
    const clean = new URL(url);
    clean.searchParams.delete("code");
    const res = withNonce(NextResponse.redirect(clean));
    res.cookies.set(COOKIE, code, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return res;
  }

  const cookie = req.cookies.get(COOKIE)?.value;
  if (cookie && timingSafeEqual(cookie, code)) return forward();

  return new NextResponse(
    "This demo's clinician view is passphrase-protected. Append ?code=… to the URL.",
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": csp } },
  );
}

/** Constant-time comparison so the gate cannot be probed character by character. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const config = {
  /**
   * Everything except static assets and the image optimiser: the CSP nonce has
   * to reach every document, not just the gated routes. The clinician gate
   * itself is applied by path inside the handler.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
