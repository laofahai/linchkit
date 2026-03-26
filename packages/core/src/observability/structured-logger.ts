/**
 * Structured Logger — JSON-format logger with trace context propagation.
 *
 * Enriches every log entry with:
 * - timestamp (ISO 8601)
 * - level (debug/info/warn/error)
 * - traceId (from active trace context, if any)
 * - depth (trace propagation depth)
 * - arbitrary context fields
 *
 * Output goes to console by default; replace `sink` for custom destinations.
 */

import type { Logger } from "../types/logger";
import { getCurrentTrace } from "./trace-context";

// ── Types ────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  depth?: number;
  [key: string]: unknown;
}

/** Function that receives a structured log entry for output */
export type LogSink = (entry: StructuredLogEntry) => void;

export interface StructuredLoggerOptions {
  /** Minimum log level to emit (default: "debug") */
  minLevel?: LogLevel;
  /** Custom sink function (default: console-based JSON output) */
  sink?: LogSink;
  /** Static fields to include in every log entry */
  defaultContext?: Record<string, unknown>;
}

// ── Level ordering ──────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ── Default sink ────────────────────────────────────────

const consoleSink: LogSink = (entry: StructuredLogEntry) => {
  const json = JSON.stringify(entry);
  switch (entry.level) {
    case "debug":
      console.debug(json);
      break;
    case "info":
      console.info(json);
      break;
    case "warn":
      console.warn(json);
      break;
    case "error":
      console.error(json);
      break;
  }
};

// ── StructuredLogger ────────────────────────────────────

/**
 * Create a structured logger that implements the Logger interface.
 *
 * Automatically enriches log entries with trace context (traceId, depth)
 * when called within a `withTrace` scope.
 */
export function createStructuredLogger(options: StructuredLoggerOptions = {}): Logger {
  const { minLevel = "debug", sink = consoleSink, defaultContext = {} } = options;
  const minOrder = LEVEL_ORDER[minLevel];

  function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minOrder) return;

    const trace = getCurrentTrace();
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...defaultContext,
      ...(context ?? {}),
    };

    // Inject trace context when available
    if (trace) {
      entry.traceId = trace.traceId;
      entry.depth = trace.depth;
    }

    sink(entry);
  }

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
  };
}

/** Collect log entries in memory (useful for testing) */
export function createTestLogSink(): { entries: StructuredLogEntry[]; sink: LogSink } {
  const entries: StructuredLogEntry[] = [];
  return {
    entries,
    sink: (entry) => entries.push(entry),
  };
}
