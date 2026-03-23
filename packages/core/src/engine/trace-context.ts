/**
 * Trace Context — Global propagation depth tracking
 *
 * Tracks the depth of event/action propagation across the system
 * to prevent infinite loops in Action → Event → Flow → Action chains.
 * Uses AsyncLocalStorage to propagate context automatically.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceState {
  /** Unique trace ID for the entire chain */
  traceId: string;
  /** Current propagation depth */
  depth: number;
  /** Maximum allowed depth */
  maxDepth: number;
}

const traceStorage = new AsyncLocalStorage<TraceState>();

const DEFAULT_MAX_DEPTH = 20;

/** Get the current trace state, or undefined if not in a trace */
export function getCurrentTrace(): TraceState | undefined {
  return traceStorage.getStore();
}

/**
 * Run a function within a trace context.
 * If already in a trace, increments depth. Otherwise creates a new trace.
 * Throws if max depth is exceeded.
 */
export function withTrace<T>(
  fn: () => T | Promise<T>,
  maxDepth = DEFAULT_MAX_DEPTH,
): T | Promise<T> {
  const parent = traceStorage.getStore();

  const state: TraceState = parent
    ? { traceId: parent.traceId, depth: parent.depth + 1, maxDepth: parent.maxDepth }
    : { traceId: crypto.randomUUID(), depth: 0, maxDepth: maxDepth };

  if (state.depth > state.maxDepth) {
    throw new Error(
      `Trace depth limit (${state.maxDepth}) exceeded (trace=${state.traceId}). ` +
        "Possible infinite loop in Action → Event → Flow chain.",
    );
  }

  return traceStorage.run(state, fn);
}

/** Get current trace depth, or 0 if not in a trace */
export function getTraceDepth(): number {
  return traceStorage.getStore()?.depth ?? 0;
}
