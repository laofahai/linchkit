/**
 * Watcher condition primitives (Spec 45).
 *
 * Pure, stateless helpers shared by the watcher subsystems (engine, schedule,
 * mutation). Extracted from `watcher-engine.ts` to keep that file under the
 * repo's 500-line ceiling; the engine re-exports them so the public surface is
 * unchanged.
 */

import type { WatcherComparisonCondition } from "@linchkit/core";

// ── Duration parsing ──────────────────────────────────────

/**
 * Parse a duration string (e.g. '48h', '7d', '30m', '1h30m') to milliseconds.
 * Supported units: d (days), h (hours), m (minutes), s (seconds).
 */
export function parseDuration(duration: string): number | null {
  const regex = /^(\d+)(d|h|m|s)$/;
  const match = duration.trim().match(regex);
  if (!match) return null;

  const value = Number.parseInt(match[1] as string, 10);
  const unit = match[2] as string;

  switch (unit) {
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "m":
      return value * 60 * 1000;
    case "s":
      return value * 1000;
    default:
      return null;
  }
}

// ── Comparison evaluator ──────────────────────────────────

/** Evaluate a WatcherComparisonCondition against a numeric value */
export function evaluateComparison(value: number, condition: WatcherComparisonCondition): boolean {
  if (condition.gt !== undefined && !(value > condition.gt)) return false;
  if (condition.gte !== undefined && !(value >= condition.gte)) return false;
  if (condition.lt !== undefined && !(value < condition.lt)) return false;
  if (condition.lte !== undefined && !(value <= condition.lte)) return false;
  if (condition.eq !== undefined && !(value === condition.eq)) return false;
  return true;
}
