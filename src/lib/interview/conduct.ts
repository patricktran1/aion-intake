import type { Fact, Intake, IntakeBundle } from "@/lib/domain/types";
import { CERTAINTY } from "@/lib/domain/types";
import { track } from "@/lib/analytics";
import { callText, callTool, isModelEnabled, modelName } from "@/lib/ai/client";
import { round6 } from "@/lib/ai/cost";
import {
  SYSTEM_HPI,
  SYSTEM_INTERVIEWER,
  TURN_TOOL,
  hpiUserPrompt,
  turnUserPrompt,
} from "@/lib/ai/prompts";
import { acceptOrFallbackHpi, ageFrom, composeHpiDeterministic } from "@/lib/ai/compose";
import { isSafeQuestion } from "@/lib/ai/guard";
import {
  isPartiallyFilled,
  classifyCertainty,
  computeOpenQuestions,
  detectPathway,
  detectUrgent,
  extractDeterministic,
  findSlot,
  isEmptyAnswer,
  isNonAnswer,
  planNextQuestion,
  tidy,
} from "./engine";
import { countConcerns, harvest } from "./harvest";
import { MAX_QUESTIONS, OPENING_SLOT, PATHWAY_SLOTS, type Slot } from "./slots";

/** After this many unanswered questions in a row, stop asking. */
const SKIP_TOLERANCE = 2;

/**
 * Orchestration for one conversational turn.
 *
 * The engine decides *what* to ask. The model, when configured, decides *how* to
 * say it and pulls structure out of the answer. If the model is absent, slow, or
 * returns something that fails validation, the deterministic path takes over
 * silently and the patient notices nothing.
 */

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

export interface TurnResult {
  intake: Intake;
  /** The assistant's next message, or null when the interview is complete. */
  nextQuestion: string | null;
  finished: boolean;
}

interface RawTurn {
  facts?: unknown;
  patient_questions?: unknown;
  next_question?: unknown;
}

/** Words too common to say anything about whether a restatement is grounded. */
const FILLER_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "it", "its", "this", "that", "these", "those", "i", "my", "me", "we", "our",
  "he", "she", "they", "them", "his", "her", "their", "you", "your",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "as", "about",
  "have", "has", "had", "do", "does", "did", "not", "no", "so", "if", "then",
  "there", "here", "up", "down", "out", "over", "some", "any", "very", "just",
  "patient", "reports", "reported", "states", "stated", "describes", "described",
]);

const NUMERIC_WORD =
  /^\d+$|^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/;

/**
 * True when a restatement is built from words the patient actually used.
 *
 * Not a paraphrase detector — a fabrication detector. A model that keeps the
 * patient's vocabulary and rearranges it passes; one that introduces a duration,
 * a body site or a drug name the patient never said does not.
 *
 * This closes the gap the verbatim check leaves open: a correctly quoted
 * fragment does not make the restatement printed beside it true. The model
 * could quote "a while" faithfully and still write "three months", and it is
 * the restatement a physician reads.
 */
export function isGroundedRestatement(value: string, answer: string): boolean {
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9%\s]/g, " ").split(/\s+/).filter(Boolean);

  const haystack = new Set(words(answer));
  const content = words(value).filter((w) => !FILLER_WORDS.has(w) && w.length > 1);
  if (content.length === 0) return true;

  // Numbers and units are where fabrication does the most damage, so any the
  // patient did not use fails the whole restatement.
  if (content.some((w) => NUMERIC_WORD.test(w) && !haystack.has(w))) return false;

  const found = content.filter((w) => haystack.has(w)).length;
  return found / content.length >= 0.6;
}

/** Validates a model turn payload. Anything unexpected is discarded, not coerced. */
export function parseTurn(
  raw: unknown,
  allowedSlots: string[],
  answer: string,
  at: string,
): { facts: Fact[]; patientQuestions: string[]; nextQuestion: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as RawTurn;
  if (!Array.isArray(r.facts)) return null;

  const facts: Fact[] = [];
  for (const f of r.facts) {
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const slot = typeof o.slot === "string" ? o.slot : "";
    const value = typeof o.value === "string" ? o.value.trim() : "";
    const verbatim = typeof o.verbatim === "string" ? o.verbatim.trim() : "";
    const certainty = typeof o.certainty === "string" ? o.certainty : "";
    if (!allowedSlots.includes(slot)) continue;
    if (!value) continue;
    if (!(CERTAINTY as readonly string[]).includes(certainty)) continue;

    // Provenance rule: the quoted verbatim must genuinely appear in the answer.
    const grounded = verbatim.length > 0 && answer.toLowerCase().includes(verbatim.toLowerCase());

    // The value is the model's restatement, and it is what a physician reads.
    // A grounded quote does not make the restatement beside it true — the model
    // could quote "a while" correctly and still write "three months". So the
    // restatement has to be built from words the patient actually used; when it
    // is not, their own words are used instead.
    const safeValue = isGroundedRestatement(value, answer) ? tidy(value) : tidy(grounded ? verbatim : answer);

    facts.push({
      slot,
      value: safeValue.slice(0, 240),
      verbatim: grounded ? verbatim : answer.trim(),
      certainty: certainty as Fact["certainty"],
      source: "patient",
      at,
    });
  }

  // A patient question is shown to the physician as `Patient asked: "..."`.
  // That is a quotation, so it has to be one — anything the model composed
  // rather than lifted is discarded.
  const patientQuestions = Array.isArray(r.patient_questions)
    ? r.patient_questions
        .filter((q): q is string => typeof q === "string" && q.trim().length > 2)
        .map((q) => q.trim().slice(0, 200))
        .filter((q) => isGroundedRestatement(q, answer))
    : [];

  const nq = typeof r.next_question === "string" ? r.next_question.trim() : "";
  return { facts, patientQuestions, nextQuestion: nq || null };
}

/**
 * The previous turn only.
 *
 * Resending the whole transcript every turn is the classic cost trap, and it
 * buys nothing here: the engine holds every fact and decides every question, so
 * the model needs just enough context to make its phrasing flow.
 */
function recentTranscript(intake: Intake, turns = 1): string {
  return intake.messages
    .slice(-turns * 2)
    .map((m) => `${m.role === "assistant" ? "AION" : "Patient"}: ${m.text}`)
    .join("\n");
}

function addUsage(intake: Intake, input: number, output: number, cost: number): Intake {
  return {
    ...intake,
    aiUsage: {
      ...intake.aiUsage,
      calls: intake.aiUsage.calls + 1,
      inputTokens: intake.aiUsage.inputTokens + input,
      outputTokens: intake.aiUsage.outputTokens + output,
      estimatedCostUsd: round6(intake.aiUsage.estimatedCostUsd + cost),
      model: modelName(),
      mode: "model",
    },
  };
}

/** Opening turn: no answer yet, just the first question. */
export function startIntake(intake: Intake): TurnResult {
  const question = OPENING_SLOT.question;
  const next: Intake = {
    ...intake,
    status: "in_progress",
    startedAt: intake.startedAt ?? new Date().toISOString(),
    questionCount: 1,
    askedSlots: [OPENING_SLOT.id],
    messages: [
      ...intake.messages,
      { id: uid("msg"), role: "assistant", text: question, at: new Date().toISOString(), targets: [OPENING_SLOT.id] },
    ],
  };
  return { intake: next, nextQuestion: question, finished: false };
}

export async function conductTurn(args: {
  intake: Intake;
  answer: string;
  inputMode: "text" | "voice";
}): Promise<TurnResult> {
  const at = new Date().toISOString();
  let intake = args.intake;
  const answer = args.answer.trim();

  const lastAssistant = [...intake.messages].reverse().find((m) => m.role === "assistant");
  const askedSlotId = lastAssistant?.targets[0] ?? OPENING_SLOT.id;
  const isOpening = askedSlotId === OPENING_SLOT.id;

  if (isOpening && answer) {
    intake = { ...intake, pathway: detectPathway(answer), concernCount: countConcerns(answer) };
  } else if (intake.pathway === "general" && intake.questionCount <= 2 && answer) {
    // One chance to correct course. A vague opener ("there's a thing on my
    // cheek") often becomes obvious on the next answer ("it bleeds and scabs"),
    // and it is cheap to switch before the pathway-specific questions begin.
    const revised = detectPathway(`${lastPatientText(intake)} ${answer}`);
    if (revised !== "general") intake = { ...intake, pathway: revised };
  }
  if (answer && detectUrgent(answer)) {
    intake = { ...intake, urgentFlag: true };
  }

  const askedSlot: Slot = findSlot(intake.pathway, askedSlotId) ?? OPENING_SLOT;

  intake = {
    ...intake,
    messages: [
      ...intake.messages,
      { id: uid("msg"), role: "patient", text: answer, at, targets: [], inputMode: args.inputMode },
    ],
    voiceTurns: intake.voiceTurns + (args.inputMode === "voice" ? 1 : 0),
    textTurns: intake.textTurns + (args.inputMode === "text" ? 1 : 0),
  };

  // An empty answer is a valid answer: it means "skip". Never trap the patient.
  const empty = isEmptyAnswer(answer);

  // Plan the next question deterministically, before any model call.
  let planned = planNextQuestion({
    pathway: intake.pathway,
    facts: empty ? intake.facts : [...intake.facts, ...extractDeterministic(askedSlot, answer, at)],
    askedSlots: intake.askedSlots,
    questionCount: intake.questionCount,
  });

  let facts: Fact[] = [];
  let patientQuestions: string[] = [];
  let questionText: string | null = questionFor(planned.slot, intake.facts);

  if (!empty) {
    if (isModelEnabled()) {
      const res = await callTool<RawTurn>({
        system: SYSTEM_INTERVIEWER,
        user: turnUserPrompt({
          askedQuestion: lastAssistant?.text ?? OPENING_SLOT.question,
          askedSlot: askedSlot.id,
          facets: askedSlot.facets,
          answer,
          nextQuestion: questionFor(planned.slot, intake.facts),
          recentTranscript: recentTranscript(intake),
        }),
        tool: TURN_TOOL,
      });
      intake = addUsage(intake, res.inputTokens, res.outputTokens, res.costUsd);
      track("ai_call", { purpose: "turn", ok: res.ok, input_tokens: res.inputTokens, output_tokens: res.outputTokens });

      const parsed = res.ok ? parseTurn(res.data, [askedSlot.id], answer, at) : null;
      if (parsed && parsed.facts.length > 0) {
        facts = parsed.facts;
        patientQuestions = parsed.patientQuestions;
        // Re-voicing is allowed; advising, reassuring, or naming a diagnosis is
        // not. A question that trips the guard silently reverts to the engine's
        // own wording.
        if (planned.slot && parsed.nextQuestion) {
          if (isSafeQuestion(parsed.nextQuestion)) {
            questionText = parsed.nextQuestion;
          } else {
            track("ai_fallback", { purpose: "question_guard" });
          }
        }
      } else {
        track("ai_fallback", { purpose: "turn", reason: res.error ?? "validation" });
        facts = extractDeterministic(askedSlot, answer, at);
      }
    } else {
      facts = extractDeterministic(askedSlot, answer, at);
    }
  }

  // When the patient volunteered half an answer and we asked a narrowed
  // follow-up, the two halves belong in one row, not two.
  const priorPartial = intake.facts.find(
    (f) => f.slot === askedSlot.id && f.partial === true && f.harvested === true,
  );
  const mergeAddsSomething =
    priorPartial !== undefined &&
    facts.length > 0 &&
    !facts[0].value.toLowerCase().includes(priorPartial.value.toLowerCase()) &&
    !priorPartial.value.toLowerCase().includes(facts[0].value.toLowerCase());

  if (priorPartial && facts.length > 0 && mergeAddsSomething) {
    const merged: Fact = {
      ...priorPartial,
      value: `${priorPartial.value.replace(/[.;]$/, "")}; ${lowerFirstChar(facts[0].value)}`.slice(0, 400),
      verbatim: `${priorPartial.verbatim} / ${facts[0].verbatim}`.slice(0, 2000),
      certainty: facts[0].certainty === "stated" ? priorPartial.certainty : facts[0].certainty,
      partial: false,
    };
    intake = {
      ...intake,
      facts: [...intake.facts.filter((f) => f !== priorPartial), merged, ...facts.slice(1)],
    };
  } else if (priorPartial && facts.length > 0) {
    // The follow-up restated what was already volunteered. Keep the fuller of
    // the two rather than joining a sentence to itself.
    const keep = facts[0].value.length >= priorPartial.value.length ? facts[0] : priorPartial;
    intake = {
      ...intake,
      facts: [...intake.facts.filter((f) => f !== priorPartial), { ...keep, partial: false }, ...facts.slice(1)],
    };
  } else {
    intake = { ...intake, facts: [...intake.facts, ...facts] };
  }

  // Read anything else the answer already covered, so we do not ask for it.
  // Most valuable on the opening answer, where patients tell their whole story.
  if (!empty && answer.length >= 25) {
    const alreadyHave = new Set(intake.facts.map((f) => f.slot));
    const eligible = PATHWAY_SLOTS[intake.pathway]
      .map((sl) => sl.id)
      .filter((sid) => sid !== askedSlot.id && !alreadyHave.has(sid) && !intake.askedSlots.includes(sid));
    const harvested = harvest(answer, eligible, at);
    if (harvested.length > 0) {
      intake = { ...intake, facts: [...intake.facts, ...harvested] };
      track("intake_facts_harvested", {
        intake_id: intake.id,
        count: harvested.length,
        from_opening: isOpening,
      });
    }
  }
  if (patientQuestions.length > 0) {
    intake = { ...intake, patientQuestions: [...intake.patientQuestions, ...patientQuestions] };
  } else if (!empty && /\b(will|does|is|can|should|could|what|why|how)\b.*\?/i.test(answer)) {
    // The patient asked something in passing; carry it to the physician verbatim.
    const q = answer.split(/(?<=\?)/).find((s) => s.includes("?"));
    if (q) intake = { ...intake, patientQuestions: [...intake.patientQuestions, q.trim().slice(0, 200)] };
  }

  const skipped = empty || isNonAnswer(answer);
  intake = {
    ...intake,
    consecutiveSkips: skipped ? intake.consecutiveSkips + 1 : 0,
  };

  // A patient who has stopped answering is not going to start. Ending early is
  // kinder than grinding through the remaining questions, and the physician
  // learns more from "they disengaged" than from six blank slots.
  const disengaged =
    intake.consecutiveSkips >= SKIP_TOLERANCE && intake.questionCount >= 3;

  const replanned = planNextQuestion({
    pathway: intake.pathway,
    facts: intake.facts,
    askedSlots: intake.askedSlots,
    questionCount: intake.questionCount,
  });
  if (replanned.slot?.id !== planned.slot?.id) {
    // Harvesting filled the slot we were about to ask about. Take the next one
    // and, since the model phrased a question for the old slot, use the
    // engine's own wording for the new one.
    planned = replanned;
    questionText = questionFor(replanned.slot, intake.facts);
  }

  const finished = !planned.slot || intake.questionCount >= MAX_QUESTIONS || disengaged;

  if (finished || !questionText || !planned.slot) {
    intake = { ...intake, openQuestions: computeOpenQuestions(intake) };
    track("intake_question_answered", {
      intake_id: intake.id,
      slot: askedSlot.id,
      input_mode: args.inputMode,
      empty,
      certainty: empty ? "unclear" : classifyCertainty(answer),
      question_index: intake.questionCount,
    });
    if (disengaged) track("intake_ended_early", { intake_id: intake.id, reason: "disengaged" });
    return { intake, nextQuestion: null, finished: true };
  }

  intake = {
    ...intake,
    questionCount: intake.questionCount + 1,
    askedSlots: [...intake.askedSlots, planned.slot.id],
    messages: [
      ...intake.messages,
      { id: uid("msg"), role: "assistant", text: questionText, at: new Date().toISOString(), targets: [planned.slot.id] },
    ],
  };

  track("intake_question_answered", {
    intake_id: intake.id,
    slot: askedSlot.id,
    input_mode: args.inputMode,
    empty,
    certainty: empty ? "unclear" : classifyCertainty(answer),
    question_index: intake.questionCount,
  });

  return { intake, nextQuestion: questionText, finished: false };
}

/**
 * Draft HPI generation.
 *
 * The deterministic composer runs first and is the guaranteed output. A model
 * pass is attempted only to improve readability, and its result is used only if
 * the guard finds nothing invented. That ordering is the point: prose quality is
 * an upgrade, faithfulness is not negotiable.
 */
export async function generateHpi(bundle: IntakeBundle): Promise<{ intake: Intake; usedModel: boolean }> {
  let intake = bundle.intake;
  const deterministic = composeHpiDeterministic(bundle);

  if (!isModelEnabled() || intake.facts.length === 0) {
    intake = { ...intake, hpi: deterministic, hpiGenerated: deterministic };
    return { intake, usedModel: false };
  }

  const factLines = intake.facts
    .map((f) => `- ${f.slot} — ${f.value} — "${f.verbatim}" — ${f.certainty}`)
    .join("\n");

  const res = await callText({
    system: SYSTEM_HPI,
    user: hpiUserPrompt({
      age: ageFrom(bundle.patient.dateOfBirth),
      facts: factLines,
      photos: intake.photos.length,
    }),
    maxTokens: 600,
  });
  intake = addUsage(intake, res.inputTokens, res.outputTokens, res.costUsd);
  track("ai_call", { purpose: "hpi", ok: res.ok, input_tokens: res.inputTokens, output_tokens: res.outputTokens });

  if (!res.ok || !res.data) {
    track("ai_fallback", { purpose: "hpi", reason: res.error ?? "empty" });
    intake = { ...intake, hpi: deterministic, hpiGenerated: deterministic };
    return { intake, usedModel: false };
  }

  const verdict = acceptOrFallbackHpi(res.data, { ...bundle, intake });
  if (!verdict.accepted) {
    track("ai_fallback", {
      purpose: "hpi_guard",
      violations: verdict.violations.length,
      first_violation: verdict.violations[0]?.kind,
    });
  }
  intake = { ...intake, hpi: verdict.text, hpiGenerated: verdict.text };
  return { intake, usedModel: verdict.accepted };
}

/**
 * The wording for a slot: the narrowed follow-up when the patient has already
 * volunteered half the answer, the full question otherwise.
 */
function questionFor(slot: Slot | null | undefined, facts: Fact[]): string | null {
  if (!slot) return null;
  if (slot.narrowQuestion && isPartiallyFilled(facts, slot.id)) return slot.narrowQuestion;
  return slot.question;
}

function lowerFirstChar(s: string): string {
  return s.length > 1 && /[a-z]/.test(s[1]) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** The patient's most recent message, used when re-checking the pathway. */
function lastPatientText(intake: Intake): string {
  const patientTurns = intake.messages.filter((m) => m.role === "patient");
  return patientTurns[patientTurns.length - 1]?.text ?? "";
}
