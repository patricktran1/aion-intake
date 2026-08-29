import type { EvalCase } from "../lib/types";
import type { Pathway } from "@/lib/domain/types";

/**
 * Programmatically generated corpus for aggregate metrics and fuzz coverage.
 *
 * Deterministic (seeded by index, no RNG) so a run is reproducible. These cases
 * carry only light assertions — the universal invariants plus pathway — because
 * their job is breadth: every pathway crossed with every answer-completeness
 * level and every language style, so the aggregate robustness and economy
 * numbers rest on hundreds of interviews, not a handful.
 */

interface Template {
  pathway: Exclude<Pathway, "general"> | "general";
  opening: string;
  /** Full, well-formed answers keyed by slot. Degraded variants derive from these. */
  answers: Record<string, string>;
}

const TEMPLATES: Template[] = [
  {
    pathway: "rash",
    opening: "I have an itchy rash on my {loc}",
    answers: {
      location: "My {loc}, hasn't spread much",
      timeline: "About {dur}, {prog}",
      symptoms: "{sym}",
      triggers: "{trig}",
      exposures: "Nothing new that I noticed",
      treatments: "{tx}",
      atopy: "No eczema or asthma in the family",
      context: "No regular medications",
      goal: "I want it to clear up",
    },
  },
  {
    pathway: "lesion",
    opening: "There's a spot on my {loc} I want checked",
    answers: {
      location: "My {loc}",
      lesion_timeline: "About {dur}, {prog}",
      lesion_symptoms: "{sym}",
      sun_history: "Fair amount of sun over the years",
      lesion_others: "No other spots",
      treatments: "{tx}",
      context: "No medications",
      goal: "Make sure it's nothing serious",
    },
  },
  {
    pathway: "acne",
    opening: "I keep breaking out on my {loc}",
    answers: {
      acne_distribution: "Mostly my {loc}, some marks left behind",
      timeline: "About {dur}, {prog}",
      acne_treatments: "{tx}",
      acne_pattern: "{trig}",
      acne_impact: "It bothers me a fair bit",
      context: "No medications",
      goal: "Clearer skin",
    },
  },
  {
    pathway: "hair_loss",
    opening: "My hair has been {sym} for a while",
    answers: {
      hair_pattern: "More of an overall thinning",
      timeline: "About {dur}, {prog}",
      hair_scalp: "Scalp feels normal",
      hair_stressors: "Nothing major happened before it",
      hair_care: "Nothing unusual",
      treatments: "{tx}",
      context: "No medications",
      goal: "Will it grow back",
    },
  },
  {
    pathway: "general",
    opening: "My {loc} have gone thick and discoloured",
    answers: {
      location: "My {loc}",
      timeline: "About {dur}, {prog}",
      symptoms: "{sym}",
      treatments: "{tx}",
      triggers: "{trig}",
      context: "No medications",
      goal: "Get them looking normal",
    },
  },
];

const LOCS: Record<string, string[]> = {
  rash: ["forearms", "back", "neck and chest", "hands", "legs"],
  lesion: ["cheek", "upper back", "shoulder", "scalp", "forearm"],
  acne: ["jaw and chin", "forehead", "back and chest", "cheeks"],
  hair_loss: ["scalp", "crown", "temples"],
  general: ["toenails", "fingernails"],
};
const DURS = ["two weeks", "a couple of months", "six months", "a year", "a few years"];
const PROGS = ["getting worse", "staying about the same", "slowly improving", "it comes and goes"];
const SYMS: Record<string, string[]> = {
  rash: ["itchy, no pain", "burning and itchy", "itchy and scaly", "sore when scratched"],
  lesion: ["it doesn't bleed", "it bled once", "no symptoms", "it itches sometimes"],
  acne: [""],
  hair_loss: ["falling out in the shower", "thinning noticeably", "shedding a lot"],
  general: ["not painful, just ugly", "a bit tender"],
};
const TRIGS = ["nothing I can pin down", "worse when stressed", "worse in the heat", "worse before my period"];
const TXS = [
  "nothing so far",
  "a drugstore cream, didn't help",
  "hydrocortisone, helped a little then came back",
  "a prescription from my GP, some improvement",
];

/** Language-style transforms applied to an answer string. */
const STYLES: { name: string; fn: (s: string) => string }[] = [
  { name: "plain", fn: (s) => s },
  { name: "lowercase-no-punct", fn: (s) => s.toLowerCase().replace(/[.,]/g, "") },
  { name: "typos", fn: (s) => s.replace(/th/g, "ht").replace(/ing\b/g, "ign").replace(/\bthe\b/g, "teh") },
  { name: "run-on", fn: (s) => s.replace(/[.,]/g, "") + " and yeah thats about it i guess" },
  { name: "terse", fn: (s) => s.split(/[.,]/)[0].split(" ").slice(0, 4).join(" ") },
  { name: "emoji", fn: (s) => s + " 🙂" },
];

const pick = <T,>(arr: T[], i: number): T => arr[i % arr.length];
const fill = (tmpl: string, vars: Record<string, string>) =>
  tmpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

/** Completeness levels: how much of the interview the synthetic patient answers. */
type Completeness = "full" | "partial" | "sparse";

function buildCase(index: number): EvalCase {
  const t = TEMPLATES[index % TEMPLATES.length];
  const p = t.pathway;
  const loc = pick(LOCS[p] ?? ["skin"], index);
  const vars = {
    loc,
    dur: pick(DURS, index + 1),
    prog: pick(PROGS, index + 2),
    sym: pick(SYMS[p] ?? [""], index + 3),
    trig: pick(TRIGS, index + 4),
    tx: pick(TXS, index + 5),
  };
  const style = pick(STYLES, index);
  const completeness: Completeness = (["full", "full", "partial", "sparse"] as Completeness[])[index % 4];

  const rawAnswers: Record<string, string> = {};
  const slotKeys = Object.keys(t.answers);
  slotKeys.forEach((slot, si) => {
    const filled = fill(t.answers[slot], vars).trim();
    if (!filled) return;
    // Degrade based on completeness: partial skips ~1/3, sparse skips ~2/3.
    if (completeness === "partial" && si % 3 === 2) return;
    if (completeness === "sparse" && si % 3 !== 0) return;
    rawAnswers[slot] = style.fn(filled);
  });

  // Heavy typos deliberately mangle the routing keyword ("breaking out" ->
  // "breakign out"); recovering that is the model layer's job, not the
  // deterministic router's, so those cases do not assert an exact pathway.
  const routingSurvives = style.name !== "typos";
  return {
    id: `gen-${p}-${style.name}-${completeness}-${index}`,
    expectPathway: routingSurvives ? p : "any",
    opening: style.fn(fill(t.opening, vars)),
    answers: rawAnswers,
    fallback: completeness === "sparse" ? "not sure" : "",
    probes: `Generated ${p} case, ${style.name} style, ${completeness} answers.`,
    tags: ["generated", p, style.name, completeness],
    // Light assertions: universal invariants run automatically; pin the pathway
    // only on well-formed styles (heavy typos legitimately degrade routing).
    assert:
      style.name === "plain" || style.name === "lowercase-no-punct" || style.name === "terse"
        ? { maxQuestions: 9 }
        : { maxQuestions: 9 },
  };
}

export function generatedCorpus(n = 240): EvalCase[] {
  return Array.from({ length: n }, (_, i) => buildCase(i));
}
