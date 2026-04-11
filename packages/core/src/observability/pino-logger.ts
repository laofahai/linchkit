/**
 * Pino-backed Logger implementation.
 *
 * Adapts pino to the LinchKit Logger interface with automatic
 * trace context injection from the current AsyncLocalStorage scope.
 */

import pino from "pino";
import type { Logger } from "../types/logger";
import { getCurrentTrace } from "./trace-context";

export interface PinoLoggerOptions {
  /** Logger name (appears in every log entry) */
  name?: string;
  /** Minimum log level (default: LOG_LEVEL env or "info") */
  level?: string;
  /** Enable pretty printing (default: auto-detect TTY + non-production) */
  pretty?: boolean;
  /** Static fields to include in every log entry */
  defaultContext?: Record<string, unknown>;
}

/**
 * Create a Logger backed by pino.
 *
 * Automatically enriches log entries with traceId and depth
 * from the current trace context (if any).
 */
export function createPinoLogger(options: PinoLoggerOptions = {}): Logger {
  // Auto-detect: pretty when TTY + non-production, unless explicitly set
  const autoPretty = process.stdout?.isTTY === true && process.env.NODE_ENV !== "production";

  const {
    name,
    level = process.env.LOG_LEVEL ?? "info",
    pretty = autoPretty,
    defaultContext = {},
  } = options;

  // Use pino-pretty transport when enabled and available
  let transportConfig: pino.TransportSingleOptions | undefined;
  if (pretty) {
    try {
      require.resolve("pino-pretty");
      transportConfig = {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss",
        },
      };
    } catch {
      // pino-pretty not installed, fall back to JSON
    }
  }

  const pinoInstance = pino({
    name,
    level,
    ...(transportConfig ? { transport: transportConfig } : {}),
  });

  function buildBindings(context?: Record<string, unknown>): Record<string, unknown> {
    const trace = getCurrentTrace();
    return {
      ...defaultContext,
      ...(trace ? { traceId: trace.traceId, depth: trace.depth } : {}),
      ...(context ?? {}),
    };
  }

  return {
    debug: (message, context) => pinoInstance.debug(buildBindings(context), message),
    info: (message, context) => pinoInstance.info(buildBindings(context), message),
    warn: (message, context) => pinoInstance.warn(buildBindings(context), message),
    error: (message, context) => pinoInstance.error(buildBindings(context), message),
  };
}
