/**
 * Helpers for SchedulerStatusPanel — the cadence-loop heartbeat panel.
 *
 * Kept separate from the JSX component so the data-shaping logic (ms humanizer,
 * status → tone/label mapping, response → view-state reducer) can be unit-tested
 * without a DOM. The component file imports from here.
 *
 * This module never imports from `@linchkit/core` or the server — the wire type
 * is mirrored locally (see `SchedulerStatus` in `lib/evolution-api.ts`).
 */

import type { SchedulerStatusResult } from "@/lib/evolution-api";

// ── View tone ──────────────────────────────────────────────

/** Visual tone for the status pill. */
export type SchedulerTone = "running" | "idle" | "disabled" | "denied" | "error";

/**
 * Compact view model the panel renders. Derived from the discriminated
 * `SchedulerStatusResult` so the JSX stays dumb. Numeric / string fields are
 * only present in the `running`/`idle` tones (i.e. `configured: true`).
 */
export interface SchedulerStatusView {
  /** Drives the pill colour + label. */
  tone: SchedulerTone;
  /** i18n key for the pill label (caller resolves with a fallback default). */
  labelKey: string;
  /** Human default for the pill label (paired with `labelKey`). */
  labelDefault: string;
  /** Optional one-line message (e.g. error text or denial reason). */
  message?: string;
  /** Present only when the scheduler is wired (`configured: true`). */
  detail?: SchedulerStatusDetail;
}

/** The numeric / timestamp detail shown when the scheduler is wired. */
export interface SchedulerStatusDetail {
  running: boolean;
  intervalMs: number;
  ticksStarted: number;
  ticksCompleted: number;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastTickDurationMs: number | null;
  lastError: string | null;
  consecutiveErrors: number;
}

// ── ms humanizer ───────────────────────────────────────────

/**
 * Humanize a millisecond duration into a compact label (e.g. 300000 → "5m",
 * 1500 → "1.5s", 90000 → "1m 30s"). Returns "—" for non-finite / negative
 * input so the UI never shows "NaNms".
 *
 * Kept deliberately small: ms → s → m → h. Days are unlikely for a cadence
 * interval or a tick duration, so they fold into hours.
 */
export function humanizeMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    // Show one decimal for sub-minute, but drop a trailing ".0".
    const rounded = Math.round(totalSeconds * 10) / 10;
    if (rounded < 60) {
      return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}s`;
    }
    // rounded up to exactly 60.0s → fall through so it renders as "1m", not "60s".
  }
  // Round to whole seconds FIRST, then decompose — flooring minutes before
  // rounding the remainder can carry to 60 and render impossible labels like
  // "59m 60s" (e.g. 3_599_999ms) or "60s" (e.g. 59_999ms).
  const roundedSeconds = Math.round(totalSeconds);
  const totalMinutes = Math.floor(roundedSeconds / 60);
  const remSeconds = roundedSeconds - totalMinutes * 60;
  if (totalMinutes < 60) {
    return remSeconds > 0 ? `${totalMinutes}m ${remSeconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remMinutes = totalMinutes - hours * 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

// ── response → view-state reducer ──────────────────────────

/**
 * Reduce the discriminated `SchedulerStatusResult` into the flat view model the
 * panel renders. Pure — no fetching, no side effects. The component calls this
 * once per fetch result and renders the returned `SchedulerStatusView`.
 */
export function toSchedulerStatusView(result: SchedulerStatusResult): SchedulerStatusView {
  switch (result.kind) {
    case "ok": {
      const s = result.status;
      if (!s.configured) {
        return {
          tone: "disabled",
          labelKey: "evolution.scheduler.pill.disabled",
          labelDefault: "Disabled",
        };
      }
      return {
        tone: s.running ? "running" : "idle",
        labelKey: s.running ? "evolution.scheduler.pill.running" : "evolution.scheduler.pill.idle",
        labelDefault: s.running ? "Running" : "Idle",
        detail: {
          running: s.running,
          intervalMs: s.intervalMs,
          ticksStarted: s.ticksStarted,
          ticksCompleted: s.ticksCompleted,
          lastTickStartedAt: s.lastTickStartedAt,
          lastTickCompletedAt: s.lastTickCompletedAt,
          lastTickDurationMs: s.lastTickDurationMs,
          lastError: s.lastError,
          consecutiveErrors: s.consecutiveErrors,
        },
      };
    }
    case "denied":
      return {
        tone: "denied",
        labelKey: "evolution.scheduler.pill.denied",
        labelDefault: "Unauthorized",
      };
    case "error":
      return {
        tone: "error",
        labelKey: "evolution.scheduler.pill.error",
        labelDefault: "Unavailable",
        message: result.message,
      };
  }
}

/** True when the detail block carries an active error streak worth surfacing. */
export function hasErrorStreak(detail: SchedulerStatusDetail | undefined): boolean {
  return !!detail && detail.consecutiveErrors > 0;
}

/**
 * Localize an ISO timestamp for display, returning "—" for null/empty/invalid
 * input so the UI never shows "Invalid Date".
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}
