import { NextResponse, type NextRequest } from "next/server";

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
  const code = process.env.CLINICIAN_ACCESS_CODE;
  if (!code) return NextResponse.next();

  const url = req.nextUrl;
  const supplied = url.searchParams.get("code");
  if (supplied && timingSafeEqual(supplied, code)) {
    const clean = new URL(url);
    clean.searchParams.delete("code");
    const res = NextResponse.redirect(clean);
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
  if (cookie && timingSafeEqual(cookie, code)) return NextResponse.next();

  return new NextResponse(
    "This demo's clinician view is passphrase-protected. Append ?code=… to the URL.",
    { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
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
  matcher: ["/clinician/:path*", "/api/clinician/:path*", "/api/metrics"],
};
