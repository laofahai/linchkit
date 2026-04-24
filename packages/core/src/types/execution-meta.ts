/**
 * ExecutionMeta — typed, immutable execution metadata propagation (Spec 65).
 *
 * ExecutionMeta carries arbitrary key-value context through the entire execution
 * chain (Action -> EventHandler -> nested Actions). It is read-only once
 * constructed; framework code extends it on nested calls via {@link ExecutionMetaImpl.extend}.
 *
 * System-only keys (prefixed with `_`) may only be set by the framework.
 * External callers' `_`-prefixed keys are silently stripped.
 */

/** Default 8 KB size limit for the JSON-serialized meta payload (Spec 65 §10.2). */
export const DEFAULT_META_MAX_BYTES = 8192;

/**
 * Error thrown when the serialized meta payload exceeds the configured size limit.
 * Uses a plain Error subclass to avoid the `ErrorCode` "a.b.c" format constraint
 * on LinchKitError — the `code` field here is the 2-part marker the CommandLayer
 * surfaces in `ActionResult.data.code` (consistent with PIPELINE error codes).
 */
export class MetaSizeError extends Error {
  readonly code = "META.SIZE_EXCEEDED";
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(sizeBytes: number, maxBytes: number) {
    super(`Execution meta size ${sizeBytes} bytes exceeds limit of ${maxBytes} bytes`);
    this.name = "MetaSizeError";
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * Immutable execution metadata that propagates through the entire execution
 * chain (Action -> EventHandler -> nested Actions).
 * Used for cross-cutting concerns, caller hints, and integration metadata.
 */
export interface ExecutionMeta {
  /** Get a metadata value by key */
  get<T = unknown>(key: string): T | undefined;

  /** Get a metadata value, throwing if not present */
  require<T = unknown>(key: string): T;

  /** Check if a key exists */
  has(key: string): boolean;

  /** Get all metadata as a plain object (shallow copy) */
  toJSON(): Record<string, unknown>;
}

/**
 * Check whether a value is safely JSON-serializable as a plain primitive /
 * array / object. Drops functions, class instances, Symbols, and circular
 * references (Spec 65 §10.4).
 */
function isJsonSerializable(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t === "function" || t === "symbol" || t === "undefined" || t === "bigint") return false;
  // object — arrays and plain objects only; try a JSON round-trip as a
  // cheap guard against circular refs / class instances with custom
  // toJSON that throw.
  try {
    JSON.stringify(value);
  } catch {
    return false;
  }
  // Reject non-plain objects (class instances, Dates, Maps, etc.).
  // Plain objects have Object.prototype or null prototype; arrays pass too.
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strip `_`-prefixed keys from an input object (returns a shallow copy). */
function stripSystemKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

/** Filter to JSON-serializable values only. */
function filterSerializable(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (isJsonSerializable(v)) out[k] = v;
  }
  return out;
}

/**
 * Internal implementation of {@link ExecutionMeta}.
 *
 * Framework code uses {@link extend} to build child meta on nested `ctx.execute`
 * calls. Handler code sees only the {@link ExecutionMeta} interface and cannot
 * mutate the store.
 */
export class ExecutionMetaImpl implements ExecutionMeta {
  private readonly data: ReadonlyMap<string, unknown>;

  constructor(entries: Record<string, unknown>) {
    this.data = new Map(Object.entries(entries));
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  require<T = unknown>(key: string): T {
    if (!this.data.has(key)) {
      throw new Error(`Required meta key "${key}" not found`);
    }
    return this.data.get(key) as T;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }

  /**
   * Create a child meta by merging `extra` into the current entries.
   *
   * Semantics (Spec 65 §4.3, §4.4):
   * - `_`-prefixed keys in `extra` are silently dropped (system-only namespace).
   * - For remaining keys, parent wins — `extra` keys only add new entries.
   * - `systemOverrides` is applied unconditionally (framework-owned updates
   *   like `_depth`, `_source_action`).
   *
   * Framework-only; not exposed on the {@link ExecutionMeta} interface so
   * handler code cannot accidentally extend meta (use `ctx.execute(..., { meta })`
   * instead).
   */
  extend(
    extra: Record<string, unknown>,
    systemOverrides?: Record<string, unknown>,
  ): ExecutionMetaImpl {
    const merged: Record<string, unknown> = { ...this.toJSON() };
    const strippedExtra = stripSystemKeys(extra);
    for (const [k, v] of Object.entries(strippedExtra)) {
      // Parent always wins — child can only add new keys.
      if (!Object.hasOwn(merged, k)) {
        merged[k] = v;
      }
    }
    if (systemOverrides) {
      Object.assign(merged, systemOverrides);
    }
    return new ExecutionMetaImpl(merged);
  }
}

/**
 * Helper for framework code that only has access to the {@link ExecutionMeta}
 * interface (e.g., when propagating through `ctx.execute` without widening the
 * public type). Delegates to {@link ExecutionMetaImpl.extend} when the input is
 * an `ExecutionMetaImpl`; otherwise reconstructs from `toJSON()`.
 *
 * Keeping `extend` off the public `ExecutionMeta` interface is a deliberate
 * read-only affordance for handlers (Spec 65 §4.2 — handlers must not mutate
 * meta; only the framework extends on nested calls).
 */
export function extendExecutionMeta(
  parent: ExecutionMeta,
  extra: Record<string, unknown>,
  systemOverrides?: Record<string, unknown>,
): ExecutionMetaImpl {
  if (parent instanceof ExecutionMetaImpl) {
    return parent.extend(extra, systemOverrides);
  }
  // Fallback for non-standard implementations: reconstruct via toJSON().
  const impl = new ExecutionMetaImpl(parent.toJSON());
  return impl.extend(extra, systemOverrides);
}

export interface CreateExecutionMetaOptions {
  /** Caller-provided raw meta (external input). `_`-prefixed keys stripped. */
  raw?: Record<string, unknown>;
  /** Framework-set system keys (e.g., `_channel`, `_execution_id`, `_depth`). */
  systemKeys?: Record<string, unknown>;
  /** Max serialized size in bytes. Defaults to {@link DEFAULT_META_MAX_BYTES}. */
  maxSizeBytes?: number;
}

/**
 * Build a fresh {@link ExecutionMeta} from raw caller input + framework system keys.
 *
 * Merge order (later sources win for the same key, except `_`-prefixed keys
 * which are always stripped from `raw`):
 * 1. Strip `_` keys from `raw` (external callers cannot set system keys — §4.4).
 * 2. Filter non-JSON-serializable values from the stripped raw (§10.4).
 * 3. Apply `systemKeys` on top (framework keys always win).
 * 4. Enforce {@link CreateExecutionMetaOptions.maxSizeBytes} on the JSON payload.
 *
 * @throws {MetaSizeError} When the serialized meta exceeds the size limit.
 */
export function createExecutionMeta(options: CreateExecutionMetaOptions = {}): ExecutionMeta {
  const { raw = {}, systemKeys = {}, maxSizeBytes = DEFAULT_META_MAX_BYTES } = options;

  const strippedRaw = stripSystemKeys(raw);
  const safeRaw = filterSerializable(strippedRaw);
  // System keys are framework-owned — trust them, but still filter non-
  // serializable values so a bad `_` key (e.g., a class instance) can't poison
  // the execution log downstream.
  const safeSystemKeys = filterSerializable(systemKeys);

  const merged: Record<string, unknown> = { ...safeRaw, ...safeSystemKeys };

  const serialized = JSON.stringify(merged);
  const sizeBytes = new TextEncoder().encode(serialized).length;
  if (sizeBytes > maxSizeBytes) {
    throw new MetaSizeError(sizeBytes, maxSizeBytes);
  }

  return new ExecutionMetaImpl(merged);
}
