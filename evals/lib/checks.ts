import type { AssertionCheck, CaseResult, EvalCase, RunArtifacts } from "./types";

/**
 * Turn a case's semantic assertions into pass/fail checks against what the
 * engine actually produced. Every check names itself so a failing report points
 * a maintainer straight at the broken promise.
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const briefAndHpi = (a: RunArtifacts) =>
  norm(a.briefRows.map((r) => `${r.text} ${r.verbatim}`).join(" ") + " " + a.hpi);

const clarifyText = (a: RunArtifacts) => norm(a.clarify.join(" "));

export function checkCase(c: EvalCase): (a: RunArtifacts) => CaseResult {
  return (a: RunArtifacts): CaseResult => {
    const checks: AssertionCheck[] = [];
    const add = (name: string, passed: boolean, detail = "") => checks.push({ name, passed, detail });

    // Universal invariants — hold for every case, always.
    add("no_crash", !a.crashed, a.error ?? "");
    add("finished", a.finished, a.finished ? "" : "interview never reached a terminal state");
    add("guard_clean", a.guardViolations.length === 0, a.guardViolations.map((v) => `${v.kind}:${v.detail}`).join("; "));
    add("no_empty_brief_row", a.briefRows.every((r) => r.text.trim().length > 0), "");
    add(
      "no_nonanswer_row",
      a.briefRows.every((r) => !/^(not sure|idk|dunno|no idea|unsure)$/i.test(r.text.trim())),
      a.briefRows.filter((r) => /^(not sure|idk|dunno)/i.test(r.text.trim())).map((r) => r.text).join("; "),
    );

    const A = c.assert ?? {};
    const hay = briefAndHpi(a);
    const clar = clarifyText(a);

    if (c.expectPathway !== "any") {
      add("pathway", a.routedPathway === c.expectPathway, `routed ${a.routedPathway}, expected ${c.expectPathway}`);
    }
    for (const s of A.mustPreserve ?? []) {
      add(`preserve:${s.slice(0, 24)}`, hay.includes(norm(s)), `"${s}" not found in brief/HPI`);
    }
    for (const s of A.mustPreserveVerbatim ?? []) {
      const found = a.briefRows.some((r) => norm(r.verbatim).includes(norm(s))) || norm(a.hpi).includes(norm(s));
      add(`verbatim:${s.slice(0, 24)}`, found, `patient phrasing "${s}" not preserved`);
    }
    for (const p of A.prohibited ?? []) {
      const present = p instanceof RegExp ? p.test(a.hpi) || a.briefRows.some((r) => p.test(r.text)) : hay.includes(norm(p));
      add(`prohibited:${String(p).slice(0, 28)}`, !present, present ? `found prohibited "${p}"` : "");
    }
    for (const cx of A.certainty ?? []) {
      const facts = a.facts.filter((f) => f.slot === cx.slot);
      const ok = facts.length > 0 && facts.some((f) => f.certainty === cx.is);
      add(`certainty:${cx.slot}`, ok, facts.length ? `slot ${cx.slot} certainty ${facts.map((f) => f.certainty)}, expected ${cx.is}` : `no fact for ${cx.slot}`);
    }
    for (const s of A.expectClarify ?? []) {
      add(`clarify:${s.slice(0, 24)}`, clar.includes(norm(s)), `clarify list missing "${s}" — got: ${a.clarify.join(" | ")}`);
    }
    if (A.clarifyEmpty) {
      add("clarify_empty", a.clarify.length === 0, `clarify not empty: ${a.clarify.join(" | ")}`);
    }
    if (typeof A.maxQuestions === "number") {
      add("max_questions", a.questionCount <= A.maxQuestions, `asked ${a.questionCount}, max ${A.maxQuestions}`);
    }
    if (A.noRedundantQuestions) {
      add("no_redundant", a.redundantQuestions.length === 0, `re-asked already-answered: ${a.redundantQuestions.join(", ")}`);
    }
    if (typeof A.urgentFlag === "boolean") {
      add("urgent_flag", a.urgentFlag === A.urgentFlag, `urgentFlag=${a.urgentFlag}, expected ${A.urgentFlag}`);
    }
    for (const s of A.mustHaveFact ?? []) {
      add(`has_fact:${s}`, a.facts.some((f) => f.slot === s), `no fact for slot ${s}`);
    }
    for (const s of A.mustNotHaveFact ?? []) {
      add(`no_fact:${s}`, !a.facts.some((f) => f.slot === s), `unexpected fact for slot ${s}`);
    }

    const passed = checks.every((ck) => ck.passed);
    return { case: c, artifacts: a, checks, passed };
  };
}
