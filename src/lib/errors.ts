/**
 * Error taxonomy.
 *
 * Two audiences, deliberately separated. The patient or clinician gets a
 * sentence they can act on. The log gets a stable code and whatever metadata
 * is needed to find the request again. Neither gets a stack trace, a SQL
 * error, a provider response, or a secret — those are the four things that
 * leak systems open, and the only reliable way to keep them out of a response
 * is to never build a response from an exception.
 *
 * Codes are stable strings because they end up in dashboards and runbooks.
 * Renaming one is a breaking change to operations, not a refactor.
 */

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "ACCESS_DENIED",
  "NOT_FOUND",
  "INTAKE_EXPIRED",
  "INTAKE_REVOKED",
  "INTAKE_COMPLETE",
  "INTAKE_NOT_STARTED",
  "VERIFICATION_REQUIRED",
  "VERIFICATION_FAILED",
  "PHOTO_INVALID",
  "PHOTO_TOO_LARGE",
  "PHOTO_LIMIT_REACHED",
  "RATE_LIMITED",
  "BAD_REQUEST",
  "MODEL_TIMEOUT",
  "MODEL_INVALID",
  "STORE_UNAVAILABLE",
  "STORE_CONFLICT",
  "OBJECT_STORE_UNAVAILABLE",
  "NOT_AVAILABLE_IN_THIS_MODE",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface Spec {
  status: number;
  /** What the person on the other end reads. Never contains internals. */
  message: string;
  /** True when retrying the identical request could plausibly succeed. */
  retryable: boolean;
}

const SPECS: Record<ErrorCode, Spec> = {
  AUTH_REQUIRED: { status: 401, message: "Please sign in to continue.", retryable: false },
  ACCESS_DENIED: { status: 403, message: "You do not have access to this.", retryable: false },
  NOT_FOUND: { status: 404, message: "That could not be found.", retryable: false },
  INTAKE_EXPIRED: {
    status: 410,
    message: "This intake link has expired. Your practice can send you a new one.",
    retryable: false,
  },
  INTAKE_REVOKED: {
    status: 410,
    message: "This intake link is no longer valid. Please contact your practice.",
    retryable: false,
  },
  INTAKE_COMPLETE: {
    status: 409,
    message: "This intake has been submitted and can no longer be changed.",
    retryable: false,
  },
  INTAKE_NOT_STARTED: { status: 409, message: "This intake hasn't been started yet.", retryable: false },
  VERIFICATION_REQUIRED: {
    status: 401,
    // Deliberately does not name the factor: which one is in force is a per-token
    // fact, and the screen gets the exact wording from the challenge endpoint.
    message: "Please confirm it's you before opening this intake.",
    retryable: false,
  },
  VERIFICATION_FAILED: {
    status: 401,
    message: "That did not match our records. Please check and try again.",
    retryable: true,
  },
  PHOTO_INVALID: { status: 400, message: "That file didn't look like a photo. Please try again.", retryable: false },
  PHOTO_TOO_LARGE: {
    status: 413,
    message: "That photo is too large to upload. Try taking it again at a normal size.",
    retryable: false,
  },
  PHOTO_LIMIT_REACHED: { status: 409, message: "You've added the maximum number of photos.", retryable: false },
  RATE_LIMITED: {
    status: 429,
    message: "You're going a little fast — give it a moment and try again.",
    retryable: true,
  },
  BAD_REQUEST: { status: 400, message: "That request could not be read.", retryable: false },
  MODEL_TIMEOUT: { status: 503, message: "That took too long. Please try again.", retryable: true },
  MODEL_INVALID: { status: 502, message: "Something went wrong. Please try again.", retryable: true },
  STORE_UNAVAILABLE: {
    status: 503,
    message: "We couldn't save that just now. Your answers are safe — please try again in a moment.",
    retryable: true,
  },
  STORE_CONFLICT: { status: 409, message: "Someone else just changed this. Please reload and try again.", retryable: true },
  OBJECT_STORE_UNAVAILABLE: {
    status: 503,
    message: "We couldn't save that photo just now. Please try again in a moment.",
    retryable: true,
  },
  NOT_AVAILABLE_IN_THIS_MODE: { status: 404, message: "That could not be found.", retryable: false },
  INTERNAL: { status: 500, message: "Something went wrong on our end. Please try again.", retryable: true },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Log-only detail. Never serialised into a response. */
  readonly detail: string;
  readonly meta: Record<string, string | number | boolean>;

  constructor(code: ErrorCode, detail = "", meta: Record<string, string | number | boolean> = {}) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.meta = meta;
  }

  get status(): number {
    return SPECS[this.code].status;
  }

  get publicMessage(): string {
    return SPECS[this.code].message;
  }

  get retryable(): boolean {
    return SPECS[this.code].retryable;
  }
}

export const errorSpec = (code: ErrorCode): Spec => SPECS[code];

/**
 * Reduces any thrown value to a code. An unrecognised throw becomes INTERNAL —
 * never an error message forwarded to the client, because the messages that
 * matter most (a Postgres error, a provider 401) are exactly the ones carrying
 * connection strings, table names, and keys.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  // Postgres/driver conditions worth distinguishing for the caller's benefit,
  // matched on shape rather than forwarded verbatim.
  if (lower.includes("econnrefused") || lower.includes("connection terminated") || lower.includes("timeout expired")) {
    return new AppError("STORE_UNAVAILABLE", message);
  }
  if (lower.includes("could not serialize") || lower.includes("deadlock detected")) {
    return new AppError("STORE_CONFLICT", message);
  }
  return new AppError("INTERNAL", message);
}
