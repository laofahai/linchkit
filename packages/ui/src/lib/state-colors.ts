/**
 * Shared state color utilities.
 *
 * Maps semantic color tokens (from StateMeta.color) to CSS classes.
 * All state-rendering components (StatusBar, Badge, StatusBadge) use this
 * single source of truth instead of maintaining separate color maps.
 */

import type { StateMeta } from "@linchkit/core";

/** Semantic color tokens that can be used in StateMeta.color */
export type StateColorToken =
  | "default"
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "info";

/** Badge-style classes (filled background, small pill) for list/form badges */
const BADGE_CLASSES: Record<StateColorToken, string> = {
  default: "bg-muted text-muted-foreground",
  secondary: "bg-muted text-muted-foreground",
  success:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  warning:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
};

/** StatusBar active step classes — same palette as badges (light bg + dark text) */
const STATUS_BAR_CLASSES: Record<StateColorToken, string> = {
  default: "bg-primary/15 text-primary",
  secondary: "bg-muted text-muted-foreground",
  success:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  warning:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
};

/** Resolve a StateMeta.color string to a StateColorToken */
export function resolveColorToken(color?: string): StateColorToken {
  if (!color) return "default";
  const normalized = color.toLowerCase();
  if (normalized in BADGE_CLASSES) return normalized as StateColorToken;
  // Fallback: try to guess from common color names
  if (normalized === "green") return "success";
  if (normalized === "red") return "danger";
  if (normalized === "yellow" || normalized === "orange") return "warning";
  if (normalized === "blue") return "info";
  if (normalized === "gray" || normalized === "grey") return "secondary";
  return "default";
}

/** Get badge CSS classes for a state value, given its meta */
export function getStateBadgeClass(color?: string): string {
  return BADGE_CLASSES[resolveColorToken(color)];
}

/** Get StatusBar active step CSS classes for a state */
export function getStateBarClass(color?: string): string {
  return STATUS_BAR_CLASSES[resolveColorToken(color)];
}

/**
 * Resolve color from a state meta map.
 * Falls back to guessing from common state names if no meta provided.
 */
export function resolveStateColor(
  stateValue: string,
  meta?: Partial<Record<string, StateMeta>>,
): StateColorToken {
  // First: try state machine meta
  if (meta?.[stateValue]?.color) {
    return resolveColorToken(meta[stateValue].color);
  }
  // Fallback: guess from common state value names
  return guessColorFromName(stateValue);
}

/** Heuristic: guess color from common state value names */
function guessColorFromName(value: string): StateColorToken {
  const v = value.toLowerCase();
  if (["approved", "completed", "active", "done", "published"].includes(v))
    return "success";
  if (["pending", "submitted", "in_progress", "review"].includes(v))
    return "warning";
  if (["rejected", "failed", "error", "blocked"].includes(v)) return "danger";
  if (["draft", "cancelled", "inactive", "archived"].includes(v))
    return "secondary";
  return "default";
}
