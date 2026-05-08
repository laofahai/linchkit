/**
 * CLI entry for `bun --cwd addons/demo/cap-life-demo run demo`.
 *
 * Executes the full Sense → Memory → Awareness → Insight → Proposal cycle
 * (see `./full-cycle-demo.ts`) and pretty-prints a human-readable summary
 * to stdout. Output sections mirror the five life-system layers plus the
 * proposal pre-analysis envelopes, so a reader can verify each stage ran.
 *
 * Pure stdout — no env vars, no flags, no exit codes other than 0/1.
 * Failures bubble up as a thrown error and exit code 1.
 */

import { runFullCycleDemo } from "./full-cycle-demo";

function bannerLine(label: string): string {
  // Fixed-width banner so eyeballing the sections in a terminal stays aligned.
  const padded = ` ${label} `;
  const total = 60;
  const dashes = Math.max(0, total - padded.length);
  const left = Math.floor(dashes / 2);
  const right = dashes - left;
  return `${"─".repeat(left)}${padded}${"─".repeat(right)}`;
}

async function main(): Promise<void> {
  const { cycle, proposalAnalyses } = await runFullCycleDemo();

  console.log(bannerLine("Spec 55 life-system demo — full cycle"));
  console.log(`Signals collected     : ${cycle.signalsCollected}`);
  console.log(`Drifts detected       : ${cycle.driftsDetected}`);
  console.log(`Insights surfaced     : ${cycle.newInsights.length}`);
  console.log(`Total promoted        : ${cycle.totalInsights}`);
  console.log(`Proposals emitted     : ${cycle.proposals.length}`);

  console.log(bannerLine("Insights"));
  if (cycle.newInsights.length === 0) {
    console.log("(none)");
  } else {
    for (const insight of cycle.newInsights) {
      console.log(`- [${insight.type}] ${insight.entity}: ${insight.summary}`);
      console.log(
        `  confidence=${insight.confidence.toFixed(2)} impact=${insight.impact} causality=${insight.causality}`,
      );
    }
  }

  console.log(bannerLine("Proposals"));
  if (cycle.proposals.length === 0) {
    console.log("(none)");
  } else {
    for (const proposal of cycle.proposals) {
      console.log(`- ${proposal.title}`);
      console.log(`  capability=${proposal.capability} status=${proposal.status}`);
      for (const change of proposal.changes) {
        console.log(
          `    change: target=${change.target} operation=${change.operation} name=${change.name}`,
        );
      }
    }
  }

  console.log(bannerLine("Pre-analysis envelopes"));
  if (proposalAnalyses.length === 0) {
    console.log("(none)");
  } else {
    for (const { proposal, preAnalysis } of proposalAnalyses) {
      console.log(`- proposal: ${proposal.title}`);
      const dedupData = preAnalysis.stages.dedup?.data;
      const impactData = preAnalysis.stages.impact?.data;
      const dedupSimilar = dedupData ? dedupData.similar.length : "n/a";
      const dedupExact = dedupData ? (dedupData.exactMatch ? "yes" : "no") : "n/a";
      const impactCount = impactData ? impactData.affectedRecordCount : "n/a";
      const impactReason = impactData?.reason ?? "—";
      console.log(`  dedup    : similar=${dedupSimilar} exactMatch=${dedupExact}`);
      console.log(`  impact   : affectedRecordCount=${impactCount} reason=${impactReason}`);
      console.log(
        `  pipeline : allStagesSucceeded=${preAnalysis.allStagesSucceeded} totalDurationMs=${preAnalysis.totalDurationMs.toFixed(2)}`,
      );
    }
  }

  console.log(bannerLine("done"));
}

main().catch((err: unknown) => {
  console.error("[cap-life-demo] full-cycle demo failed:", err);
  process.exit(1);
});
