import type { EvalReport, KindMetrics, ScoredObservation } from "./metrics";

/**
 * Report renderers — Phase 6. Pure formatting: JSON and Markdown
 * serializations of an `EvalReport` for `test-results/eval/` artifacts and
 * the `store/evals/` baseline document. No I/O, no clock.
 */

/** JSON.stringify with recursively sorted object keys (arrays keep order). */
function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON serialization of the report (ends with a newline). */
export function renderEvalJson(report: EvalReport): string {
  return `${stableStringify(report)}\n`;
}

function pct(x: number | null): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

function fmt(x: number | null, digits = 3): string {
  return x === null ? "n/a" : x.toFixed(digits);
}

function fmtValue(v: ScoredObservation["predicted"]): string {
  if (v === null) return "—";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function kindRow(name: string, m: KindMetrics): string {
  return `| ${name} | ${m.cases} | ${m.answered} | ${pct(m.coverage)} | ${pct(m.accuracy)} | ${pct(m.reviewRate)} | ${pct(m.unsureRate)} | ${pct(m.autoApplyRate)} | ${pct(m.incorrectAutoApplyRate)} |`;
}

/** Human-readable Markdown report for the store baseline document. */
export function renderEvalMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push("# Jev evaluation report");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Corpus: v${report.corpusVersion}`);
  lines.push(`- Models: ${report.modelIds.join(", ") || "none"}`);
  lines.push(
    `- Thresholds: review ≥ ${report.thresholds.reviewFloor}, auto-apply ≥ ${report.thresholds.autoApply}, preselect ≥ ${report.thresholds.movePreselect}, no-match < ${report.thresholds.noMatchBar}, tag ≥ ${report.thresholds.tagSelect}`,
  );
  lines.push("");
  lines.push("## Question-set versions");
  lines.push("");
  for (const [set, version] of Object.entries(report.questionSetVersions)) {
    lines.push(`- ${set}: ${version}`);
  }
  lines.push("");
  lines.push("## Headline metrics");
  lines.push("");
  lines.push(`- Coverage: ${t.answered}/${t.cases} answered (${pct(t.coverage)})`);
  lines.push(
    `- Accuracy: ${t.correct}/${t.answered} correct (${pct(t.accuracy)})`,
  );
  lines.push(
    `- Policy outcomes of answered: review ${pct(t.reviewRate)}, unsure ${pct(t.unsureRate)}, preselect ${t.preselect}, auto-apply ${pct(t.autoApplyRate)}`,
  );
  lines.push(
    `- Incorrect auto-apply: ${t.incorrectAutoApply}/${t.answered} (${pct(t.incorrectAutoApplyRate)})`,
  );
  lines.push("");
  lines.push("## Per question set");
  lines.push("");
  lines.push(
    "| set | cases | answered | coverage | accuracy | review | unsure | auto-apply | incorrect auto-apply |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|");
  lines.push(kindRow("categorize", report.perKind.categorize));
  lines.push(kindRow("tags", report.perKind.tags));
  lines.push(kindRow("placement", report.perKind.placement));
  lines.push(kindRow("misfiled", report.perKind.misfiled));
  lines.push(kindRow("near_duplicate", report.perKind.near_duplicate));
  lines.push(kindRow("rerank", report.perKind.rerank));
  lines.push(kindRow("**total**", t));
  lines.push("");
  lines.push("## Set-specific metrics");
  lines.push("");
  const tags = report.perKind.tags;
  lines.push(
    `- tags: micro precision ${fmt(tags.microPrecision)}, micro recall ${fmt(tags.microRecall)}, micro F1 ${fmt(tags.microF1)}, exact set matches ${tags.exactMatches}`,
  );
  const nd = report.perKind.near_duplicate;
  lines.push(
    `- near_duplicate: within-one accuracy ${pct(nd.withinOneAccuracy)}, mean absolute error ${fmt(nd.meanAbsoluteError)}`,
  );
  const mis = report.perKind.misfiled;
  lines.push(
    `- misfiled: detection precision ${fmt(mis.detectionPrecision)}, recall ${fmt(mis.detectionRecall)}`,
  );
  const rr = report.perKind.rerank;
  lines.push(
    `- rerank: micro precision ${fmt(rr.microPrecision)}, micro recall ${fmt(rr.microRecall)}, micro F1 ${fmt(rr.microF1)}, no-match outcomes ${rr.noMatch}`,
  );
  lines.push("");

  const failures = report.scored.filter(
    (s) => s.answered && s.correct === false,
  );
  const missed = report.scored.filter((s) => !s.answered);
  if (failures.length > 0 || missed.length > 0) {
    lines.push("## Failures and gaps");
    lines.push("");
    lines.push("| case | kind | outcome | expected | predicted |");
    lines.push("|---|---|---|---|---|");
    for (const s of failures) {
      lines.push(
        `| ${s.caseId} | ${s.kind} | ${s.outcome}${s.incorrectAutoApply ? " (incorrect auto-apply)" : ""} | ${fmtValue(s.expected)} | ${fmtValue(s.predicted)} |`,
      );
    }
    for (const s of missed) {
      lines.push(
        `| ${s.caseId} | ${s.kind} | ${s.status} | ${fmtValue(s.expected)} | — |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
