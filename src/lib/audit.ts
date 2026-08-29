/**
 * Audit.
 *
 * An audit log answers "who did what to which record, when". It is not a
 * second copy of the record, and the difference matters: a log that quotes the
 * HPI becomes another place clinical content lives, with weaker access control
 * than the database it was copied from and a longer retention period. So the
 * meta payload is filtered here, on the way in, with the same allowlist
 * discipline the analytics and logging layers use.
 *
 * Writes never throw into the caller. A brief that fails to open because the
 * audit insert failed is a worse outcome than a missing audit row, and the
 * failure is logged loudly enough to be noticed.
 */

import { store, type Actor, type AuditAction } from "@/lib/store";
import { log } from "@/lib/log";

/** Meta values must be small and non-clinical. Strings are capped hard. */
const MAX_META_STRING = 64;
const META_DENY = ["text", "answer", "verbatim", "name", "hpi", "note", "content", "email", "dob", "body"];

export type AuditMeta = Record<string, string | number | boolean | undefined>;

export function sanitizeMeta(meta: AuditMeta): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (!/^[a-z][a-z0-9_]{0,32}$/.test(k)) continue;
    if (META_DENY.some((d) => k.includes(d))) continue;
    if (typeof v === "string") {
      // A value longer than an identifier is prose, and prose in an audit row
      // is the thing this filter exists to stop. Drop rather than truncate.
      if (v.length > MAX_META_STRING) continue;
      out[k] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

export interface AuditInput {
  action: AuditAction;
  actor: Actor;
  resource: string;
  resourceId?: string | null;
  requestId?: string | null;
  practiceId?: string | null;
  meta?: AuditMeta;
}

function actorId(actor: Actor): string | null {
  if (actor.kind === "clinician") return actor.clinicianId;
  if (actor.kind === "patient") return actor.intakeId;
  return null;
}

function actorPractice(actor: Actor): string | null {
  return actor.kind === "clinician" ? actor.practiceId : null;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    const s = await store();
    await s.appendAudit({
      action: input.action,
      actorKind: input.actor.kind,
      actorId: actorId(input.actor),
      practiceId: input.practiceId ?? actorPractice(input.actor),
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? null,
      meta: sanitizeMeta(input.meta ?? {}),
    });
  } catch (err) {
    // Loud, but not fatal to the request.
    log.error("audit write failed", {
      action: input.action,
      resource: input.resource,
      reason: err instanceof Error ? err.name : "unknown",
    });
  }
}
