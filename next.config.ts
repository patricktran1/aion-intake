import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * Chosen to be strict without breaking the two browser capabilities the
 * product genuinely needs: the microphone (voice answers) and the camera
 * (photographs). Permissions-Policy therefore allows both for this origin and
 * denies everything else worth denying.
 *
 * The CSP allows inline styles because Next injects them, and 'unsafe-inline'
 * for scripts is NOT granted — the app ships no inline script it needs.
 * `connect-src 'self'` matters most here: it means a page compromised by some
 * other route still cannot post a patient's answers to another origin.
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // data: is required because the synthetic demo holds photos as data URLs;
  // pilot photos are served from same-origin routes.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // Two years, subdomains included. Harmless on http://localhost, where
  // browsers ignore it.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Nothing about the runtime should be inferable from a response header.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Photos are held as data URLs inside the in-memory demo store; keep the
  // body limit generous enough for three phone photos but not unbounded.
  experimental: {
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
