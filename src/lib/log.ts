/**
 * Structured logging and request correlation.
 *
 * One rule, enforced rather than remembered: a log line may describe what
 * happened to a record, never what the record says. A request id, a route, a
 * status, a duration and an internal identifier are all fine. A patient's
 * answer, a name, an HPI, a prompt or a photo is not — those belong in the
 * database, behind authorization, and nowhere else.
 *
 * The enforcement is `emit()` below: fields go through a shape check, and
 * anything that looks like free text is dropped rather than truncated. A
 * truncated clinical sentence in a log is still a clinical sentence in a log.
 */

import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue = string | number | boolean | null | undefined;

/**
 * Field names allowed to carry a string. Everything else must be a number or
 * boolean. An allowlist rather than a denylist: a new field carrying patient
 * text should be silently dropped by default, not silently logged.
 */
const STRING_FIELDS = new Set([
  "request_id",
  "route",
  "method",
  "mode",
  "actor",
  "actor_kind",
  "practice_id",
  "intake_id",
  "visit_id",
  "photo_id",
  "clinician_id",
  "event",
  "code",
  "error_code",
  "reason",
  "action",
  "resource",
  "resource_id",
  "outcome",
  "model",
  "purpose",
  "pathway",
  "slot",
  "migration",
  "object_key",
]);

/** A string field is still capped: an identifier is short by construction. */
const MAX_STRING = 96;

export interface LogFields {
  [key: string]: LogValue;
}

function safeFields(fields: LogFields): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    if (typeof v !== "string") continue;
    // Strings are the risk. Only allowlisted identifier-shaped fields may
    // carry one, and even then only if it is actually identifier-shaped.
    if (!STRING_FIELDS.has(k)) continue;
    if (v.length > MAX_STRING) continue;
    if (/\s{2,}|[\n\r\t]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

const QUIET = () => process.env.NODE_ENV === "test" || process.env.AION_LOG_ANALYTICS === "0";

export function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  const line = {
    at: new Date().toISOString(),
    level,
    msg: message,
    ...safeFields(fields),
  };
  if (QUIET()) return;
  const text = `[aion] ${JSON.stringify(line)}`;
  if (level === "error") console.error(text);
  else if (level === "warn") console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (m: string, f?: LogFields) => emit("debug", m, f),
  info: (m: string, f?: LogFields) => emit("info", m, f),
  warn: (m: string, f?: LogFields) => emit("warn", m, f),
  error: (m: string, f?: LogFields) => emit("error", m, f),
};

/** Exposed so tests can assert the field policy directly. */
export const __testing = { safeFields };

/**
 * Request correlation.
 *
 * Honours an inbound x-request-id when it is well formed so a proxy's id
 * survives into our logs, and mints one otherwise. Rejecting a malformed
 * inbound value matters: it is attacker-controlled and ends up in log lines.
 */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

export function requestIdFrom(req: { headers: { get(name: string): string | null } }): string {
  const supplied = req.headers.get("x-request-id");
  if (supplied && REQUEST_ID_SHAPE.test(supplied)) return supplied;
  return randomUUID();
}

export const REQUEST_ID_HEADER = "x-request-id";
