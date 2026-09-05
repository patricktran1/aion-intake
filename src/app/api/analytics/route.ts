import { fail, json } from "@/lib/api";
import { readJson } from "@/lib/http";
import { track, type AnalyticsEvent } from "@/lib/analytics";
import { LIMITS, clientKey } from "@/lib/ratelimit";
import { enforce } from "@/lib/ratelimit-enforce";

/**
 * The only analytics events a browser may report. Everything else is recorded
 * server-side where it cannot be forged, and no free text is accepted here.
 */
const CLIENT_EVENTS: AnalyticsEvent[] = [
  "clinician_hpi_copied",
  "clinician_note_copied",
  "intake_voice_used",
];

export async function POST(req: Request) {
  // Unauthenticated by design — a copy-to-clipboard is not worth a credential —
  // which makes it the one write surface anyone at all can reach. It was also
  // unlimited, and the in-memory ring it writes into holds a fixed number of
  // events: a loop against this endpoint evicted every genuine metric and left
  // a dashboard reporting only what the attacker sent. Bounded per address, and
  // the body is capped well below anything a real event needs.
  if (!(await enforce(clientKey(req, "analytics"), LIMITS.analytics))) {
    return fail("rate_limited", 429);
  }

  let body: unknown;
  try {
    body = await readJson(req, 4 * 1024);
  } catch {
    return fail("bad_request", 400);
  }
  const b = (body ?? {}) as { event?: unknown; intakeId?: unknown };
  const event = CLIENT_EVENTS.find((e) => e === b.event);
  if (!event) return fail("unknown_event", 400);
  track(event, {
    intake_id: typeof b.intakeId === "string" ? b.intakeId.slice(0, 64) : undefined,
  });
  return json({ ok: true });
}
