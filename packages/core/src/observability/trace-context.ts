/**
 * Trace Context — Global propagation depth tracking
 *
 * Tracks the depth of event/action propagation across the system
 * to prevent infinite loops in Action → Event → Flow → Action chains.
 * Uses AsyncLocalStorage to propagate context automatically.
 *
 * Browser-safe: falls back to a simple variable-based store when
 * AsyncLocalStorage is unavailable (e.g., Vite client bundles).
 */

export interface TraceState {
  /** Unique trace ID for the entire chain */
  traceId: string;
  /** Current propagation depth */
  depth: number;
  /** Maximum allowed depth */
  maxDepth: number;
}

// Minimal interface matching AsyncLocalStorage usage
interface StoreLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

// Browser fallback: single-variable store (no concurrency in browsers)
class SimpleStore<T> implements StoreLike<T> {
  private current: T | undefined;
  getStore(): T | undefined {
    return this.current;
  }
  run<R>(store: T, fn: () => R): R {
    const prev = this.current;
    this.current = store;
    try {
      return fn();
    } finally {
      this.current = prev;
    }
  }
}

// Use AsyncLocalStorage when available (Node/Bun), fallback for browsers
let traceStorage: StoreLike<TraceState>;
try {
  // Dynamic require to avoid Vite externalization error
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require returns untyped module
  const hooks: any = globalThis.process ? require("node:async_hooks") : {};
  const ALS = hooks.AsyncLocalStorage;
  traceStorage = ALS ? new ALS() : new SimpleStore<TraceState>();
} catch {
  // AsyncLocalStorage unavailable (e.g. browser/Vite env) — fall back to simple store
  traceStorage = new SimpleStore<TraceState>();
}

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

/**
 * Run a function within a trace context with a specific traceId.
 * Used to restore a persisted trace chain (e.g., OutboxWorker replaying events).
 */
export function withTraceId<T>(
  traceId: string,
  fn: () => T | Promise<T>,
  maxDepth = DEFAULT_MAX_DEPTH,
): T | Promise<T> {
  const parent = traceStorage.getStore();
  const state: TraceState = {
    traceId,
    depth: parent ? parent.depth + 1 : 0,
    maxDepth: parent?.maxDepth ?? maxDepth,
  };

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
