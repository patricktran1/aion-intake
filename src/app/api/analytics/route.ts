import { fail, json } from "@/lib/api";
import { track, type AnalyticsEvent } from "@/lib/analytics";

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
  let body: unknown;
  try {
    body = await req.json();
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
