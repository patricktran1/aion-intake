/**
 * Product analytics.
 *
 * Deliberately an abstraction over a ring buffer plus structured stdout, not a
 * vendor. Two reasons: it costs nothing before product-market fit, and it keeps
 * health information out of a third party by construction.
 *
 * RULE: event properties may contain ids, counts, durations, enums and booleans.
 * They may never contain patient free text, photo data, or names. `track()`
 * strips anything that is not a primitive and truncates strings.
 */

export const ANALYTICS_EVENTS = [
  "intake_opened",
  "intake_started",
  "intake_question_answered",
  "intake_voice_used",
  "intake_photo_uploaded",
  "intake_facts_harvested",
  "intake_ended_early",
  "intake_photo_rejected",
  "intake_review_edited",
  "intake_submitted",
  "intake_abandoned_resumed",
  "clinician_list_viewed",
  "clinician_brief_opened",
  "clinician_hpi_edited",
  "clinician_hpi_copied",
  "clinician_note_generated",
  "clinician_note_copied",
  "ai_call",
  "ai_fallback",
  "demo_reset",
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

export type EventProps = Record<string, string | number | boolean | undefined>;

export interface TrackedEvent {
  event: AnalyticsEvent;
  at: string;
  props: EventProps;
}

const MAX_EVENTS = 2000;

interface AnalyticsStore {
  events: TrackedEvent[];
}

const globalForAnalytics = globalThis as unknown as { __aionAnalytics?: AnalyticsStore };

function store(): AnalyticsStore {
  if (!globalForAnalytics.__aionAnalytics) {
    globalForAnalytics.__aionAnalytics = { events: [] };
  }
  return globalForAnalytics.__aionAnalytics;
}

/** Allowlisted key shapes. Anything else is dropped before it can leak. */
const SAFE_KEY = /^[a-z][a-z0-9_]{0,40}$/;
const DENY_SUBSTRINGS = ["text", "answer", "verbatim", "name", "photo_data", "email", "dob"];
/**
 * What a value may look like: an identifier or an enum, never prose. Same rule
 * the structured logger applies, and for the same reason — these two are the
 * places where clinical content leaks by accident rather than by decision.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,63}$/;

function sanitize(props: EventProps): EventProps {
  const out: EventProps = {};
  for (const [k, v] of Object.entries(props)) {
    if (!SAFE_KEY.test(k)) continue;
    if (DENY_SUBSTRINGS.some((d) => k.includes(d))) continue;
    // The key allowlist says WHICH facts may be recorded; it says nothing about
    // what a value contains. A caller passing a patient-influenced string under
    // an allowlisted key — a slot name, a pathway — put free text into the
    // analytics store, which is the one place that is meant to hold none. So
    // values are shaped too: an identifier, not a sentence. Anything else is
    // dropped rather than truncated, because half a sentence is still a
    // sentence and truncation hides the mistake instead of surfacing it.
    if (typeof v === "string") {
      if (IDENTIFIER.test(v)) out[k] = v;
    }
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** Exposed so a test can assert the field policy directly, as the logger does. */
export const __analyticsTesting = { sanitize };

export function track(event: AnalyticsEvent, props: EventProps = {}): void {
  const record: TrackedEvent = { event, at: new Date().toISOString(), props: sanitize(props) };
  const s = store();
  s.events.push(record);
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  // Structured line: greppable in any host's logs, no PHI by construction.
  // Off in tests and in local scripts, where it drowns the output that matters.
  if (process.env.NODE_ENV !== "test" && process.env.AION_LOG_ANALYTICS !== "0") {
    console.log(`[aion.analytics] ${JSON.stringify(record)}`);
  }
}

export function allEvents(): TrackedEvent[] {
  return [...store().events];
}

export function resetAnalytics(): void {
  store().events = [];
}

const count = (events: TrackedEvent[], e: AnalyticsEvent) =>
  events.filter((x) => x.event === e).length;

const median = (nums: number[]): number | null => {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/**
 * The handful of numbers that decide whether the wedge is real. Not a
 * dashboard — a JSON endpoint the founder reads.
 */
export function summarize() {
  const events = allEvents();
  const started = count(events, "intake_started");
  const submitted = events.filter((e) => e.event === "intake_submitted");
  const durations = submitted
    .map((e) => Number(e.props.duration_seconds))
    .filter((n) => Number.isFinite(n) && n > 0);
  const questionCounts = submitted
    .map((e) => Number(e.props.question_count))
    .filter((n) => Number.isFinite(n));
  const costs = submitted
    .map((e) => Number(e.props.ai_cost_usd))
    .filter((n) => Number.isFinite(n));
  const voiceTurns = events
    .filter((e) => e.event === "intake_question_answered")
    .filter((e) => e.props.input_mode === "voice").length;
  const answered = count(events, "intake_question_answered");

  return {
    intakes_started: started,
    intakes_completed: submitted.length,
    completion_rate: started > 0 ? Math.round((submitted.length / started) * 100) / 100 : null,
    median_completion_seconds: median(durations),
    median_questions_asked: median(questionCounts),
    voice_turn_share: answered > 0 ? Math.round((voiceTurns / answered) * 100) / 100 : null,
    photos_uploaded: count(events, "intake_photo_uploaded"),
    photos_rejected: count(events, "intake_photo_rejected"),
    patient_review_edits: count(events, "intake_review_edited"),
    clinician_briefs_opened: count(events, "clinician_brief_opened"),
    clinician_hpi_copied: count(events, "clinician_hpi_copied"),
    clinician_hpi_edited: count(events, "clinician_hpi_edited"),
    clinician_notes_copied: count(events, "clinician_note_copied"),
    ai_calls: count(events, "ai_call"),
    ai_fallbacks: count(events, "ai_fallback"),
    mean_ai_cost_per_completed_intake_usd:
      costs.length > 0
        ? Math.round((costs.reduce((a, b) => a + b, 0) / costs.length) * 1e6) / 1e6
        : 0,
  };
}
