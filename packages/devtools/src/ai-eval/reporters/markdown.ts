/**
 * Markdown reporter — emits the spec 69 §7.1 baseline report format.
 *
 * Layout: header → headline metrics → by-tag table → failures → reproduction
 * command. Intentionally writes to a string so callers control file I/O.
 */

import type { BaselineFixtureEntry, RunReport } from "../types";

export interface MarkdownReportOptions {
  /** When true, appends a small diff summary below the failures section. */
  includeDiff?: boolean;
  /**
   * Optional `fixtureId → tags` map used to populate the by-tag table.
   * Baseline entries don't carry tags themselves (spec 69 §7.2 keeps them
   * minimal); the runner or its caller can supply this map when richer
   * reports are desired.
   */
  fixtureTags?: Record<string, string[]>;
}

export function renderMarkdownReport<TOutput = unknown>(
  report: RunReport<TOutput>,
  opts: MarkdownReportOptions = {},
): string {
  const lines: string[] = [];
  const generatedDate = report.generatedAt.slice(0, 10);

  lines.push(`# AI Eval Baseline — ${report.scenario} — ${generatedDate}`);
  lines.push("");
  lines.push(`- **Runner**: @linchkit/devtools ai-eval`);
  lines.push(`- **Model**: ${report.modelId ?? "n/a"}`);
  lines.push(`- **Provider**: ${report.providerName ?? "n/a"}`);
  lines.push(`- **Fixtures**: ${report.summary.total} (${report.scenario})`);
  lines.push("");

  lines.push("## Headline metrics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  const hitRate =
    report.summary.total === 0
      ? "n/a"
      : `${formatPct(report.summary.strictPass / report.summary.total)} (${report.summary.strictPass}/${report.summary.total})`;
  lines.push(`| Strict hit rate | ${hitRate} |`);
  if (report.summary.avgPrimaryConfidence !== undefined) {
    lines.push(`| Avg primary confidence | ${report.summary.avgPrimaryConfidence.toFixed(2)} |`);
  }
  lines.push("");

  lines.push("## By tag");
  lines.push("");
  lines.push("| Tag | Fixtures | Strict pass | Avg confidence |");
  lines.push("|---|---|---|---|");
  const tagStats = aggregateByTag(report.fixtures, opts.fixtureTags ?? {});
  if (tagStats.length === 0) {
    lines.push("| (no tags) | 0 | n/a | n/a |");
  } else {
    for (const t of tagStats) {
      const passPct = t.total === 0 ? "n/a" : formatPct(t.passed / t.total);
      const avgConf =
        t.confidences.length === 0
          ? "n/a"
          : (t.confidences.reduce((a, b) => a + b, 0) / t.confidences.length).toFixed(2);
      lines.push(`| ${t.tag} | ${t.total} | ${passPct} | ${avgConf} |`);
    }
  }
  lines.push("");

  lines.push("## Failures");
  lines.push("");
  const failures = report.fixtures.filter((f) => !f.passed);
  if (failures.length === 0) {
    lines.push("_None_");
  } else {
    for (const f of failures) {
      lines.push(`### \`${f.fixtureId}\``);
      const failed = f.matcherResults
        .filter((r) => r.strict && !r.passed)
        .map((r) => `\`${r.matcher}\`${r.message ? `: ${r.message}` : ""}`);
      if (failed.length > 0) {
        lines.push(`- Matchers failed: ${failed.join("; ")}`);
      }
      lines.push("");
    }
  }

  if (opts.includeDiff && report.diff) {
    lines.push("## Diff vs prior canonical");
    lines.push("");
    const d = report.diff.summary;
    lines.push(`- Prior pass: ${d.priorPass}`);
    lines.push(`- Current pass: ${d.currentPass}`);
    lines.push(`- Delta: ${d.delta} fixtures (${d.deltaPp.toFixed(1)}pp)`);
    lines.push(`- Regressions (pass-to-fail): ${d.regressions}`);
    lines.push("");
  }

  lines.push("## Reproduction");
  lines.push("");
  // Live reports must reproduce as live runs — without AI_EVAL_LIVE=1 the
  // copied command would silently run in replay mode and re-read the
  // baseline that produced this very report. Replay reports omit the env
  // var because they really *are* offline (modelId is only set on live).
  const isLiveReport = report.modelId !== undefined;
  const envPrefix = isLiveReport ? "AI_EVAL_LIVE=1 " : "";
  const reproCmd = `${envPrefix}bun run ai:eval --scenario ${report.scenario}${
    report.modelId ? ` --model ${report.modelId}` : ""
  }`;
  lines.push("```bash");
  lines.push(reproCmd);
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

interface TagStats {
  tag: string;
  total: number;
  passed: number;
  confidences: number[];
}

function aggregateByTag<TOutput>(
  entries: BaselineFixtureEntry<TOutput>[],
  fixtureTags: Record<string, string[]>,
): TagStats[] {
  // Tag stats are computed at render time so the report struct stays simple.
  const byTag = new Map<string, TagStats>();
  for (const entry of entries) {
    const tags = fixtureTags[entry.fixtureId] ?? [];
    for (const tag of tags) {
      let stats = byTag.get(tag);
      if (!stats) {
        stats = { tag, total: 0, passed: 0, confidences: [] };
        byTag.set(tag, stats);
      }
      stats.total += 1;
      if (entry.passed) stats.passed += 1;
      const conf = extractConfidence(entry.aiOutput);
      if (conf !== undefined) stats.confidences.push(conf);
    }
  }
  return Array.from(byTag.values()).sort((a, b) => a.tag.localeCompare(b.tag));
}

function extractConfidence(output: unknown): number | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const obj = output as Record<string, unknown>;
  return typeof obj.confidence === "number" ? obj.confidence : undefined;
}

function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio)) return "n/a";
  return `${(ratio * 100).toFixed(1)}%`;
}
