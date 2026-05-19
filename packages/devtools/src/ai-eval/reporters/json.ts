/**
 * JSON reporter — pretty-printed `RunReport` for committing to history.
 *
 * Distinct from the canonical baseline file (see `baseline.ts`): this
 * captures the in-memory report including diff data, whereas baseline
 * files omit transient diff state to stay reproducible across runs.
 */

import type { RunReport } from "../types";

export function renderJsonReport<TOutput = unknown>(report: RunReport<TOutput>): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
