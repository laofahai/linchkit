/**
 * linch lint-capability <dir> — Per-capability quality checks (Spec 21 §9.1).
 *
 * Runs three DETERMINISTIC gates on a single capability directory:
 *   1. Metadata completeness (capability.json or package.json `linchkit` field)
 *   2. Core import-boundary (no @linchkit/core internals)
 *   3. Test existence (at least one test file)
 *
 * Exits non-zero when any error-level issue is found. With --json, prints the
 * raw CapabilityLintResult for CI consumption.
 */

import type { CapabilityLintResult } from "@linchkit/devtools/methodology";
import { lintCapability } from "@linchkit/devtools/methodology";
import { defineCommand } from "citty";
import consola from "consola";

export const lintCapabilityCommand = defineCommand({
  meta: {
    name: "lint-capability",
    description: "Run per-capability quality checks (metadata, import-boundary, tests)",
  },
  args: {
    dir: {
      type: "positional",
      description: "Capability directory to lint",
      required: false,
      default: ".",
    },
    json: {
      type: "boolean",
      description: "Output as JSON (for CI/CD)",
      default: false,
    },
  },
  run({ args }) {
    const dir = (args.dir as string) ?? ".";
    const outputJson = args.json as boolean;

    const result: CapabilityLintResult = lintCapability(dir);

    if (outputJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printReport(result);
    }

    if (!result.ok) {
      process.exit(1);
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────

function printReport(result: CapabilityLintResult): void {
  const errors = result.issues.filter((i) => i.level === "error");
  const warnings = result.issues.filter((i) => i.level === "warning");

  consola.info(`Linting capability: ${result.dir}`);
  console.log("");

  if (result.issues.length === 0) {
    consola.success("All capability checks passed.");
    return;
  }

  for (const issue of result.issues) {
    const loc = issue.file ? ` [${issue.file}]` : "";
    const line = `[${issue.check}] ${issue.message}${loc}`;
    if (issue.level === "error") consola.error(line);
    else consola.warn(line);
  }

  console.log("");
  if (result.ok) {
    consola.success(`Passed with ${warnings.length} warning(s).`);
  } else {
    consola.error(`Lint failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
  }
}
