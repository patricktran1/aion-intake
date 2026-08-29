import type {
  Fact,
  Intake,
  Message,
  Pathway,
  Patient,
  Photo,
  Practice,
  Visit,
} from "@/lib/domain/types";
import type { Db } from "@/lib/store";
import { DEFAULT_MODEL } from "@/lib/ai/cost";

/**
 * Synthetic demo data. There is no real patient information in this repository
 * and there never will be.
 *
 * Demo photographs are labelled placeholder graphics, not images of skin. The
 * product does not need real clinical imagery to demonstrate that photographs
 * reach the physician attached to the right story.
 */

/** Stable links printed on the home page so the demo is walkable in one click. */
export const DEMO_TOKENS = {
  acne: "demoacne0000acne0000demo0000",
  open: "demoopen0000open0000demo0000",
};

let counter = 0;
export const id = (prefix: string): string => {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${randomHex(8)}`;
};

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Intake links are bearer credentials, so they get 128 bits from the platform
 * CSPRNG rather than Math.random. See SECURITY.md for what else a real
 * deployment needs before these carry anything but synthetic data.
 */
export const newToken = (): string => randomHex(16);

const now = () => new Date().toISOString();
const daysFromNow = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function placeholderPhoto(label: string, tone: string, kind: Photo["kind"]): Photo {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="${tone}"/><rect x="24" y="24" width="752" height="552" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-dasharray="10 8"/><text x="400" y="286" font-family="ui-sans-serif,system-ui,sans-serif" font-size="30" fill="#fff" text-anchor="middle">${label}</text><text x="400" y="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="19" fill="rgba(255,255,255,.8)" text-anchor="middle">Synthetic demo placeholder — not a photograph</text></svg>`;
  return {
    id: id("pho"),
    kind,
    mime: "image/svg+xml",
    bytes: svg.length,
    width: 800,
    height: 600,
    dataUrl: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
    caption: label,
    advisories: [],
    at: minutesAgo(90),
  };
}

const fact = (
  slot: string,
  value: string,
  verbatim: string,
  certainty: Fact["certainty"] = "stated",
): Fact => ({ slot, value, verbatim, certainty, source: "patient", at: minutesAgo(95) });

const turn = (assistant: string, patient: string, targets: string[]): Message[] => [
  { id: id("msg"), role: "assistant", text: assistant, at: minutesAgo(100), targets },
  { id: id("msg"), role: "patient", text: patient, at: minutesAgo(99), targets: [], inputMode: "text" },
];

export function blankIntake(visitId: string, token = newToken()): Intake {
  return {
    id: id("int"),
    token,
    visitId,
    status: "not_started",
    pathway: "general",
    messages: [],
    facts: [],
    photos: [],
    openQuestions: [],
    patientQuestions: [],
    askedSlots: [],
    questionCount: 0,
    concernCount: 1,
    consecutiveSkips: 0,
    lastActivityAt: now(),
    voiceTurns: 0,
    textTurns: 0,
    aiUsage: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      model: DEFAULT_MODEL,
      mode: "deterministic",
    },
    hpi: "",
    hpiGenerated: "",
    hpiEditedByClinician: false,
    review: { exam: "", assessment: "", plan: "", medications: "", followUp: "" },
    note: "",
    urgentFlag: false,
  };
}

function completed(
  visitId: string,
  pathway: Pathway,
  transcript: Message[],
  facts: Fact[],
  photos: Photo[],
  askedSlots: string[],
  openQuestions: string[],
  patientQuestions: string[],
): Intake {
  const base = blankIntake(visitId);
  return {
    ...base,
    status: "ready_for_review",
    pathway,
    messages: transcript,
    facts,
    photos,
    askedSlots,
    openQuestions,
    patientQuestions,
    questionCount: askedSlots.length,
    startedAt: minutesAgo(100),
    submittedAt: minutesAgo(96),
    lastActivityAt: minutesAgo(96),
    textTurns: askedSlots.length,
  };
}

export function seedData(): Db {
  counter = 0;
  const practice: Practice = {
    id: "prac_lakeview",
    name: "Lakeview Dermatology",
    clinicianName: "Dr. A. Sandoval",
    clinicianCredential: "MD, FAAD",
  };

  const patients: Patient[] = [
    { id: "pat_maya", firstName: "Maya", lastName: "Ellison", dateOfBirth: "1991-04-12", pronouns: "she/her" },
    { id: "pat_robert", firstName: "Robert", lastName: "Osei", dateOfBirth: "1962-11-03", pronouns: "he/him" },
    { id: "pat_priya", firstName: "Priya", lastName: "Raman", dateOfBirth: "1989-07-22", pronouns: "she/her" },
    { id: "pat_daniel", firstName: "Daniel", lastName: "Whitaker", dateOfBirth: "2007-02-18", pronouns: "he/him" },
    { id: "pat_lena", firstName: "Lena", lastName: "Okafor", dateOfBirth: "1978-09-30", pronouns: "she/her" },
  ];

  const visits: Visit[] = [
    { id: "vis_maya", practiceId: practice.id, patientId: "pat_maya", scheduledFor: daysFromNow(1), reasonBooked: "Rash", location: "Lakeview — Suite 210" },
    { id: "vis_robert", practiceId: practice.id, patientId: "pat_robert", scheduledFor: daysFromNow(1), reasonBooked: "Skin check — spot on back", location: "Lakeview — Suite 210" },
    { id: "vis_priya", practiceId: practice.id, patientId: "pat_priya", scheduledFor: daysFromNow(2), reasonBooked: "Hair thinning", location: "Lakeview — Suite 210" },
    { id: "vis_daniel", practiceId: practice.id, patientId: "pat_daniel", scheduledFor: daysFromNow(3), reasonBooked: "Acne", location: "Lakeview — Suite 210" },
    { id: "vis_lena", practiceId: practice.id, patientId: "pat_lena", scheduledFor: daysFromNow(4), reasonBooked: "New appointment", location: "Lakeview — Suite 210" },
  ];

  // --- Demo patient 1: rash / dermatitis, completed -------------------------
  const mayaTranscript: Message[] = [
    ...turn(
      "What would you most like the dermatologist to help you with at your upcoming visit?",
      "I've had this itchy rash on both my arms for about three months and it's driving me crazy at night.",
      ["concern"],
    ),
    ...turn(
      "That sounds exhausting. Where on your body is it, and has it spread anywhere since it started?",
      "It started on the insides of both elbows and now it's on my neck too, and a bit on my hands.",
      ["location"],
    ),
    ...turn(
      "Got it. When did you first notice it, and has it been getting better, worse, or staying about the same?",
      "I think around May? It got much worse once the weather turned cold.",
      ["timeline"],
    ),
    ...turn(
      "Is it mostly itchy, painful, burning, or something else?",
      "Really itchy, especially at night. Not painful unless I scratch it raw.",
      ["symptoms"],
    ),
    ...turn(
      "Have you noticed anything that sets it off or makes it calm down?",
      "Hot showers make it much worse. Thick moisturiser helps for maybe an hour.",
      ["triggers"],
    ),
    ...turn(
      "Have you tried anything for it so far, and did any of it help?",
      "Just drugstore hydrocortisone and Eucerin. The hydrocortisone helped a little the first week and then stopped doing much.",
      ["treatments"],
    ),
    ...turn(
      "Have you or anyone in your family had eczema, asthma, or hay fever?",
      "I had eczema as a kid. My son has asthma.",
      ["atopy"],
    ),
    ...turn(
      "Anything the dermatologist should know about you — medications you take, allergies, or other medical conditions?",
      "I take levothyroxine. I'm allergic to sulfa drugs — I get hives.",
      ["context"],
    ),
    ...turn(
      "Last one — what would make this visit feel worth it for you?",
      "Honestly I just want to sleep through the night. And I want to know if it's the same thing I had as a kid.",
      ["goal"],
    ),
  ];

  const maya = completed(
    "vis_maya",
    "rash",
    mayaTranscript,
    [
      fact("concern", "Itchy rash on both arms for about three months, worst at night", "I've had this itchy rash on both my arms for about three months and it's driving me crazy at night.", "approximate"),
      fact("location", "Started on the insides of both elbows; now also on neck and some on hands", "It started on the insides of both elbows and now it's on my neck too, and a bit on my hands."),
      fact("timeline", "Started around May; worse since the weather turned cold", "I think around May? It got much worse once the weather turned cold.", "approximate"),
      fact("symptoms", "Very itchy, especially at night; painful only when scratched raw", "Really itchy, especially at night. Not painful unless I scratch it raw."),
      fact("triggers", "Hot showers make it much worse; thick moisturiser helps for about an hour", "Hot showers make it much worse. Thick moisturiser helps for maybe an hour.", "approximate"),
      fact("treatments", "Drugstore hydrocortisone and Eucerin; hydrocortisone helped for the first week then stopped working", "Just drugstore hydrocortisone and Eucerin. The hydrocortisone helped a little the first week and then stopped doing much."),
      fact("atopy", "Had eczema as a child; son has asthma", "I had eczema as a kid. My son has asthma."),
      fact("context", "Takes levothyroxine; sulfa allergy causing hives", "I take levothyroxine. I'm allergic to sulfa drugs — I get hives."),
      fact("goal", "Wants to sleep through the night; wants to know if this is the same condition she had as a child", "Honestly I just want to sleep through the night. And I want to know if it's the same thing I had as a kid."),
    ],
    [
      placeholderPhoto("Left inner elbow — wider view", "#8b6f5c", "wide"),
      placeholderPhoto("Left inner elbow — close-up", "#9d7d66", "close"),
    ],
    ["concern", "location", "timeline", "symptoms", "triggers", "treatments", "atopy", "context", "goal"],
    [
      "Primary concern — approximate only (\"I've had this itchy rash on both my arms for about three months…\").",
      "Timeline — approximate only (\"I think around May?\").",
      "Triggers — approximate only (\"Thick moisturiser helps for maybe an hour\").",
      "New exposures — not covered before the question budget ran out.",
    ],
    ["Is this the same thing I had as a kid?"],
  );

  // --- Demo patient 2: lesion of concern, completed -------------------------
  const robertTranscript: Message[] = [
    ...turn(
      "What would you most like the dermatologist to help you with at your upcoming visit?",
      "There's a dark spot on my upper back that my wife says has changed. I want it looked at.",
      ["concern"],
    ),
    ...turn(
      "Thanks for flagging it. Where on your body is it, and has it spread anywhere since it started?",
      "Upper back, left side, near the shoulder blade. It's just the one spot.",
      ["location"],
    ),
    ...turn(
      "How long have you had it, and has it changed at all — size, colour, shape, or border?",
      "I've had something there for years but she says it's darker and bigger than it used to be. I can't see it myself.",
      ["lesion_timeline"],
    ),
    ...turn(
      "Has it ever bled, scabbed over, itched, or been tender?",
      "It caught on a towel once and bled a little. No pain.",
      ["lesion_symptoms"],
    ),
    ...turn(
      "Have you had a lot of sun or tanning bed exposure, or any skin cancers before — in you or your family?",
      "I roofed for twenty years, so yes, plenty of sun and a lot of bad burns. My brother had a melanoma removed.",
      ["sun_history"],
    ),
    ...turn(
      "Are there other spots you'd like looked at while you're there?",
      "A couple of rough patches on my forearms, but they don't bother me.",
      ["lesion_others"],
    ),
    ...turn(
      "Have you tried anything for it so far, and did any of it help?",
      "No, nothing.",
      ["treatments"],
    ),
    ...turn(
      "Anything the dermatologist should know about you — medications you take, allergies, or other medical conditions?",
      "Lisinopril for blood pressure. No allergies I know of.",
      ["context"],
    ),
    ...turn(
      "Last one — what would make this visit feel worth it for you?",
      "I want to know if it needs to come off. My brother's turned out to be serious.",
      ["goal"],
    ),
  ];

  const robert = completed(
    "vis_robert",
    "lesion",
    robertTranscript,
    [
      fact("concern", "Dark spot on the upper back that his wife says has changed", "There's a dark spot on my upper back that my wife says has changed. I want it looked at."),
      fact("location", "Upper back, left side near the shoulder blade; single spot", "Upper back, left side, near the shoulder blade. It's just the one spot."),
      fact("lesion_timeline", "Present for years; reported by his wife as darker and larger than before — he cannot see it himself", "I've had something there for years but she says it's darker and bigger than it used to be. I can't see it myself.", "approximate"),
      fact("lesion_symptoms", "Bled once after catching on a towel; no pain", "It caught on a towel once and bled a little. No pain."),
      fact("sun_history", "Twenty years roofing with heavy sun exposure and multiple bad burns; brother had a melanoma removed", "I roofed for twenty years, so yes, plenty of sun and a lot of bad burns. My brother had a melanoma removed."),
      fact("lesion_others", "Rough patches on both forearms that do not bother him", "A couple of rough patches on my forearms, but they don't bother me."),
      fact("treatments", "Nothing tried", "No, nothing."),
      fact("context", "Takes lisinopril for blood pressure; no known allergies", "Lisinopril for blood pressure. No allergies I know of."),
      fact("goal", "Wants to know whether it needs to be removed; his brother's lesion was serious", "I want to know if it needs to come off. My brother's turned out to be serious."),
    ],
    [
      placeholderPhoto("Upper back — wider view", "#6a6f7d", "wide"),
      placeholderPhoto("Spot — close-up", "#7d8290", "close"),
      placeholderPhoto("Right forearm — rough patches", "#767b88", "unspecified"),
    ],
    ["concern", "location", "lesion_timeline", "lesion_symptoms", "sun_history", "lesion_others", "treatments", "context", "goal"],
    [
      "Timeline and change — approximate only (\"she says it's darker and bigger than it used to be\").",
      "Change is reported second-hand by his wife; patient has not seen the lesion himself.",
    ],
    ["Does it need to come off?"],
  );

  // --- Demo patient 3: hair loss, completed ---------------------------------
  const priyaTranscript: Message[] = [
    ...turn(
      "What would you most like the dermatologist to help you with at your upcoming visit?",
      "My hair has been falling out a lot in the shower for the last few months and my part looks wider.",
      ["concern"],
    ),
    ...turn(
      "Is the hair loss more of an overall thinning, a receding or widening part, or distinct patches?",
      "Widening part mostly, and a lot of shedding. No bald patches.",
      ["hair_pattern"],
    ),
    ...turn(
      "When did you first notice it, and has it been getting better, worse, or staying about the same?",
      "Around four months ago. The shedding seems to be slowing down a bit now but the part is still wide.",
      ["timeline"],
    ),
    ...turn(
      "Is the scalp itself itchy, sore, flaky, or does it look normal?",
      "It looks normal. Doesn't itch or hurt.",
      ["hair_scalp"],
    ),
    ...turn(
      "In the few months before it started, was there anything big — an illness, major stress, a weight change, pregnancy, or a new medication?",
      "I had my daughter eight months ago. And I was pretty sick with a flu in the spring.",
      ["hair_stressors"],
    ),
    ...turn(
      "How do you usually wear and treat your hair — tight styles, heat, relaxers, colour, extensions?",
      "Usually a low ponytail, colour every couple of months. No relaxers.",
      ["hair_care"],
    ),
    ...turn(
      "Have you tried anything for it so far, and did any of it help?",
      "Biotin gummies for two months. I couldn't tell any difference.",
      ["treatments"],
    ),
    ...turn(
      "Anything the dermatologist should know about you — medications you take, allergies, or other medical conditions?",
      "Just a prenatal vitamin still. I'm not sure if my iron was ever checked after the birth.",
      ["context"],
    ),
    ...turn(
      "Last one — what would make this visit feel worth it for you?",
      "I want to know if it's going to grow back or if I need to do something about it now.",
      ["goal"],
    ),
  ];

  const priya = completed(
    "vis_priya",
    "hair_loss",
    priyaTranscript,
    [
      fact("concern", "Heavy hair shedding in the shower for the last few months with a widening part", "My hair has been falling out a lot in the shower for the last few months and my part looks wider.", "approximate"),
      fact("hair_pattern", "Widening part with heavy shedding; no bald patches", "Widening part mostly, and a lot of shedding. No bald patches."),
      fact("timeline", "Started around four months ago; shedding slowing somewhat, part still wide", "Around four months ago. The shedding seems to be slowing down a bit now but the part is still wide.", "approximate"),
      fact("hair_scalp", "Scalp looks normal to her; no itch or pain", "It looks normal. Doesn't itch or hurt."),
      fact("hair_stressors", "Gave birth eight months ago; significant flu illness in the spring", "I had my daughter eight months ago. And I was pretty sick with a flu in the spring."),
      fact("hair_care", "Low ponytail; colours hair every couple of months; no relaxers", "Usually a low ponytail, colour every couple of months. No relaxers."),
      fact("treatments", "Biotin gummies for two months with no noticeable difference", "Biotin gummies for two months. I couldn't tell any difference."),
      fact("context", "Still taking a prenatal vitamin; unsure whether iron was checked after the birth", "Just a prenatal vitamin still. I'm not sure if my iron was ever checked after the birth.", "unclear"),
      fact("goal", "Wants to know whether it will regrow or whether she should act now", "I want to know if it's going to grow back or if I need to do something about it now."),
    ],
    [placeholderPhoto("Part line — top of scalp", "#5f5750", "close")],
    ["concern", "hair_pattern", "timeline", "hair_scalp", "hair_stressors", "hair_care", "treatments", "context", "goal"],
    [
      "Relevant context — patient unsure (\"I'm not sure if my iron was ever checked after the birth\").",
      "Timeline — approximate only (\"Around four months ago\").",
    ],
    ["Will it grow back?"],
  );

  // --- Two open intake links so the founder can walk the patient flow -------
  const daniel = blankIntake("vis_daniel", DEMO_TOKENS.acne);
  const lena = blankIntake("vis_lena", DEMO_TOKENS.open);

  const d: Db = {
    practices: new Map([[practice.id, practice]]),
    patients: new Map(patients.map((p) => [p.id, p])),
    visits: new Map(visits.map((v) => [v.id, v])),
    intakes: new Map([maya, robert, priya, daniel, lena].map((i) => [i.id, i])),
    seededAt: now(),
  };
  return d;
}

/**
 * The conference case.
 *
 * One patient, chosen so that a dermatologist watching over a shoulder sees the
 * whole argument in ninety seconds: a complaint that routes to a specific
 * pathway, questions that visibly adapt to the answers, one genuine uncertainty
 * that survives into "clarify in visit", and a brief that is obviously faster to
 * read than taking the history would be.
 *
 * The founder reads the answers out. Nothing else needs saying.
 */
export const CONFERENCE_CASE = {
  token: DEMO_TOKENS.acne,
  patient: "Daniel Whitaker",
  why: "Acne with early scarring — shows the acne pathway, a treatment history with different responses, and a goal with a deadline.",
  answers: [
    "I keep breaking out along my jaw and chin and now it's starting to leave scars",
    "Jawline and chin mostly, and some on my chest. The marks take months to fade and a couple have left dents",
    "About two years, and definitely worse in the last six months",
    "A benzoyl peroxide wash from the drugstore, and a clindamycin gel my GP gave me. The wash just dried me out. The gel helped for the first month and then stopped",
    "It's worse when I'm stressed, and I've noticed it flares after football",
    "It's the scarring that bothers me most. I've started turning down photos",
    "No regular medications. No allergies I know of",
    "I want to stop the scarring, and to know whether I should be on something stronger",
  ],
  /** What the founder should point at once the brief opens. */
  talkingPoints: [
    "Six questions, not forty — and the questions changed after the first answer.",
    "The treatment history is the part a dermatologist would otherwise dig for: two products, two different responses, one of them a failure after a month.",
    "\"Show patient's own words\" proves every line came from him.",
    "Clarify in visit is short, and each line is something worth thirty seconds in the room.",
  ],
} as const;

