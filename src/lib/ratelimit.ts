/**
 * Best-effort in-memory rate limiting.
 *
 * This is honest about what it is: a per-process token bucket that makes casual
 * abuse of the demo inconvenient. It is not a defence — a serverless deployment
 * runs several instances and each keeps its own counters, and an attacker with
 * more than one address is unaffected. A real deployment needs a shared limiter
 * at the edge; see PILOT_READINESS.md.
 *
 * It exists because the alternatives were worse: an unauthenticated reset
 * endpoint that anyone could call mid-demonstration, and intake endpoints that
 * would happily accept a thousand writes a second.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const globalForLimits = globalThis as unknown as { __aionLimits?: Map<string, Bucket> };

function buckets(): Map<string, Bucket> {
  if (!globalForLimits.__aionLimits) globalForLimits.__aionLimits = new Map();
  return globalForLimits.__aionLimits;
}

export interface LimitConfig {
  /** Bucket capacity: the most requests allowed in a burst. */
  burst: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
}

export const LIMITS = {
  /** A patient answering questions. Generous; typing is slow. */
  intakeWrite: { burst: 30, refillPerSecond: 0.5 },
  /**
   * Photo uploads are heavy, but a patient retaking a blurry shot two or three
   * times is normal behaviour and must not be punished for it.
   */
  photoUpload: { burst: 12, refillPerSecond: 0.2 },
  /**
   * Resetting the demo mid-presentation should not be a stranger's option, but
   * a founder resetting between two conversations at a conference is normal
   * and must never be told to wait.
   */
  demoReset: { burst: 10, refillPerSecond: 0.2 },
  /**
   * Global reset ceiling, keyed on a constant. The per-address key is
   * bypassable by rotating X-Forwarded-For, so this bounds total resets per
   * hour regardless of who asks — high enough for any real demo day, low
   * enough that a script cannot churn the store.
   */
  demoResetGlobal: { burst: 30, refillPerSecond: 0.02 },
  /**
   * Clinician sign-in, keyed per email address rather than per address.
   * Keying on IP would let one attacker lock out an entire practice sharing
   * one office connection, and would be evaded by anyone with a second
   * address anyway. Tight, because a clinician who has forgotten their
   * password should call the practice rather than guess twenty more times.
   */
  login: { burst: 8, refillPerSecond: 0.05 },
  /**
   * Patient second-factor attempts. The token itself also counts failures in
   * the database and locks after five; this bounds the rate at which those
   * five can be spent, and it survives a process restart no better than any
   * other in-memory bucket — which is why the durable counter exists too.
   */
  patientVerify: { burst: 6, refillPerSecond: 0.02 },
  /** Serving photo bytes. Generous: a brief with three photos is one page. */
  photoRead: { burst: 60, refillPerSecond: 1 },
} as const;

/** @returns true when the request may proceed. */
export function allow(key: string, config: LimitConfig, now = Date.now()): boolean {
  const map = buckets();
  const existing = map.get(key);
  const bucket = existing ?? { tokens: config.burst, updatedAt: now };

  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  bucket.tokens = Math.min(config.burst, bucket.tokens + elapsedSeconds * config.refillPerSecond);
  bucket.updatedAt = now;

  if (bucket.tokens < 1) {
    map.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  map.set(key, bucket);

  // Keep the map from growing without bound in a long-lived process.
  if (map.size > 5000) {
    for (const [k, v] of map) {
      if (now - v.updatedAt > 600_000) map.delete(k);
    }
  }
  return true;
}

/**
 * Client address, as far as the platform will tell us. Never logged.
 *
 * Only used where there is nothing better to key on. It is a poor key for
 * patient traffic: every patient in one waiting room shares an address, so
 * limiting by address would throttle a busy clinic. Patient writes key on the
 * intake token instead — one patient, one intake, one bucket.
 */
export function clientKey(req: Request, scope: string): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = req.headers.get("x-real-ip");
  return `${scope}:${forwarded || real || "local"}`;
}

/** The natural unit for patient rate limiting: this patient's own intake. */
export function intakeKey(token: string, scope: string): string {
  return `${scope}:token:${token}`;
}

export function resetRateLimits(): void {
  buckets().clear();
}

/**
 * A cross-origin POST to a state-changing endpoint has no legitimate use here.
 * Browsers always send Origin on cross-origin requests, so absence is fine.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}
