import type { CaseResult, DimensionScore, EvalReport } from "./types";
import { metricsFrom } from "./dimensions";

/** Build the machine-readable report object. */
export function buildReport(results: CaseResult[], dims: DimensionScore[], generatedAt: string): EvalReport {
  const failing = results
    .filter((r) => !r.passed)
    .map((r) => ({ id: r.case.id, failed: r.checks.filter((c) => !c.passed).map((c) => c.name) }));
  return {
    generatedAt,
    corpusSize: results.length,
    casesPassed: results.filter((r) => r.passed).length,
    casesFailed: failing.length,
    failing,
    dimensions: dims,
    metrics: metricsFrom(dims),
  };
}

const bar = (score: number | null, unit: string) => {
  if (score === null) return "     n/a";
  // Some dimensions are counts (mean questions), not fractions — show them raw.
  if (!unit.includes("fraction")) return String(score).padStart(6) + "  " + unit;
  const pct = Math.round(score * 100);
  return `${String(pct).padStart(3)}% ${"█".repeat(Math.round(score * 10)).padEnd(10, "░")}`;
};

/** Human-readable Markdown scorecard. */
export function markdownReport(report: EvalReport, baseline?: EvalReport | null): string {
  const lines: string[] = [];
  lines.push(`# AION Intake — Evaluation Report`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Corpus: ${report.corpusSize} cases · Passed: ${report.casesPassed} · Failed: ${report.casesFailed}`);
  lines.push("");
  lines.push(`## Quality scorecard`);
  lines.push("");
  lines.push(`| Dimension | Score | Unit | Detail |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const d of report.dimensions) {
    const delta = baseline ? deltaStr(d.dimension, d.score, baseline.metrics[d.dimension]) : "";
    const scoreCell = d.score === null ? "n/a" : `${d.score}${delta}`;
    lines.push(`| ${d.dimension} | ${scoreCell} | ${d.unit} | ${d.detail} |`);
  }
  lines.push("");

  const withOffenders = report.dimensions.filter((d) => d.offenders.length > 0);
  if (withOffenders.length > 0) {
    lines.push(`## Where scores are dragged down`);
    lines.push("");
    for (const d of withOffenders) {
      lines.push(`**${d.dimension}** — ${d.offenders.join(", ")}`);
      lines.push("");
    }
  }

  if (report.failing.length > 0) {
    lines.push(`## Failing cases (${report.failing.length})`);
    lines.push("");
    for (const f of report.failing.slice(0, 60)) {
      lines.push(`- \`${f.id}\` — ${f.failed.join(", ")}`);
    }
    if (report.failing.length > 60) lines.push(`- …and ${report.failing.length - 60} more`);
    lines.push("");
  }
  return lines.join("\n");
}

function deltaStr(dim: string, cur: number | null, base: number | null | undefined): string {
  if (cur === null || base === null || base === undefined) return "";
  const d = Math.round((cur - base) * 1000) / 1000;
  if (d === 0) return " (=)";
  const arrow = d > 0 ? "▲" : "▼";
  return ` (${arrow}${Math.abs(d)})`;
}

/** Terminal scorecard, compact. */
export function terminalReport(report: EvalReport, baseline?: EvalReport | null): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`AION EVAL · ${report.corpusSize} cases · ${report.casesPassed} passed · ${report.casesFailed} failed`);
  lines.push("─".repeat(78));
  for (const d of report.dimensions) {
    const delta = baseline ? deltaStr(d.dimension, d.score, baseline.metrics[d.dimension]) : "";
    lines.push(`${d.dimension.padEnd(32)} ${bar(d.score, d.unit)}${delta}`);
  }
  lines.push("─".repeat(78));
  if (report.casesFailed > 0) {
    lines.push(`Failing: ${report.failing.slice(0, 20).map((f) => f.id).join(", ")}${report.failing.length > 20 ? " …" : ""}`);
  }
  return lines.join("\n");
}
