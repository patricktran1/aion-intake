/**
 * The route authorization matrix.
 *
 * Every API route in the product, and what it requires. This is not
 * documentation that describes the code — `tests/pilot-routes.test.ts` reads
 * the filesystem and fails if a route exists that is not listed here, so a new
 * route cannot be added without someone stating its authorization class.
 *
 * That is the whole point. Route-level security fails by omission: twelve
 * routes are checked correctly and the thirteenth, added on a Friday, is not.
 * A list that the test suite keeps honest turns omission into a red build.
 */

export type AuthClass =
  /** No credential. Anyone on the internet may call it. */
  | "public"
  /** A live patient token for one intake; pilot also requires verification. */
  | "patient"
  /** A signed-in clinician in pilot; the middleware passphrase in demo. */
  | "clinician"
  /** Demo mode only — 404 in pilot. */
  | "demo-only"
  /** Pilot mode only — 404 in demo. */
  | "pilot-only";

export interface RouteSpec {
  path: string;
  methods: string[];
  auth: AuthClass;
  /** True when the route changes state and therefore needs CSRF/origin care. */
  writes: boolean;
  note: string;
}

export const ROUTES: RouteSpec[] = [
  {
    path: "/api/intake/[token]",
    methods: ["GET"],
    auth: "patient",
    writes: false,
    note: "The patient's own view of their intake. The token is the credential.",
  },
  {
    path: "/api/intake/[token]/verify",
    methods: ["GET", "POST"],
    auth: "public",
    writes: true,
    note:
      "The second factor itself, so it cannot require having passed it. GET returns only " +
      "which question to ask, never anything about the answer, and 404s for an unknown " +
      "token so it cannot confirm which links exist. Rate limited per token, and failures " +
      "are counted durably — five wrong answers kill the token.",
  },
  {
    path: "/api/intake/[token]/start",
    methods: ["POST"],
    auth: "patient",
    writes: true,
    note: "Idempotent: a double tap resumes rather than restarting.",
  },
  {
    path: "/api/intake/[token]/message",
    methods: ["POST"],
    auth: "patient",
    writes: true,
    note: "One interview turn. Serialised per intake so a retry cannot lose an answer.",
  },
  {
    path: "/api/intake/[token]/facts",
    methods: ["PATCH"],
    auth: "patient",
    writes: true,
    note: "The patient's correction on the review screen. Frozen after submission.",
  },
  {
    path: "/api/intake/[token]/photos",
    methods: ["POST"],
    auth: "patient",
    writes: true,
    note: "Bytes are inspected server-side; EXIF is refused, not stripped.",
  },
  {
    path: "/api/intake/[token]/photos/[photoId]",
    methods: ["GET", "DELETE"],
    auth: "patient",
    writes: true,
    note:
      "GET streams a patient's own uploaded photo back to them for review; DELETE removes " +
      "it before submission. Both require a verified token resolving to the owning intake.",
  },
  {
    path: "/api/intake/[token]/submit",
    methods: ["POST"],
    auth: "patient",
    writes: true,
    note: "Freezes the intake. Idempotent under the lock, so a double tap submits once.",
  },
  {
    path: "/api/intake/photo/[photoId]",
    methods: ["GET"],
    auth: "clinician",
    writes: false,
    note:
      "Photo bytes for an authorized clinician of the owning practice. The only way " +
      "to read a pilot photograph; there is no public or pre-signed URL. Every read is audited.",
  },
  {
    path: "/api/auth/login",
    methods: ["POST"],
    auth: "pilot-only",
    writes: true,
    note: "Constant-cost failure, so it cannot enumerate a practice's clinicians.",
  },
  {
    path: "/api/auth/logout",
    methods: ["POST"],
    auth: "pilot-only",
    writes: true,
    note: "Clears the cookie. Deliberately works without a valid session.",
  },
  {
    path: "/api/clinician/intakes",
    methods: ["GET"],
    auth: "clinician",
    writes: false,
    note: "Scoped to the session's practice in the query, not filtered afterwards.",
  },
  {
    path: "/api/clinician/intakes/[id]",
    methods: ["PATCH"],
    auth: "clinician",
    writes: true,
    note: "HPI and review fields only. Patient facts are never overwritten from this side.",
  },
  {
    path: "/api/clinician/intakes/[id]/note",
    methods: ["POST"],
    auth: "clinician",
    writes: true,
    note: "Generates the post-visit note from the clinician's own scratchpad.",
  },
  {
    path: "/api/demo/reset",
    methods: ["POST"],
    auth: "demo-only",
    writes: true,
    note:
      "Wipes and reseeds the synthetic store. 404 in pilot mode, and pilot config " +
      "refuses to start with the enabling flag set — two independent locks.",
  },
  {
    path: "/api/health",
    methods: ["GET"],
    auth: "public",
    writes: false,
    note:
      "Liveness and readiness. Reports app up and database+schema reachable, nothing else. " +
      "No versions, hostnames, or error detail. Object storage and model are not hard deps.",
  },
  {
    path: "/api/metrics",
    methods: ["GET"],
    auth: "clinician",
    writes: false,
    note: "Aggregate counts only. Behind the same gate as the clinician view.",
  },
  {
    path: "/api/analytics",
    methods: ["POST"],
    auth: "public",
    writes: true,
    note:
      "Client-side product events. Accepts an allowlisted event name and non-clinical " +
      "properties; free text is dropped by the analytics sanitiser, not stored.",
  },
];

export const routeFor = (path: string): RouteSpec | undefined => ROUTES.find((r) => r.path === path);
