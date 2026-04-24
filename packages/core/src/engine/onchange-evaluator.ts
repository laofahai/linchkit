/**
 * Onchange evaluator (Spec 64).
 *
 * Runs a per-entity onchange map for a single triggering field change. Handles:
 * - Comma-separated trigger keys (`"a,b"` fires when either `a` or `b` changes).
 * - Chained evaluation: when a hook updates field B, B's own hook fires next
 *   (breadth-first, visited-set short-circuits cycles).
 * - Depth cap: at most MAX_CHAIN_DEPTH hook evaluations per call, with a warning
 *   when the cap is reached.
 * - Strict `updates` allowlist: fields returned outside the hook's declared
 *   `updates` list are silently dropped with a structured warning.
 * - Per-hook timeout: default 2 s (Spec 64 §9.4); on timeout the hook is skipped
 *   with a warning and the chain continues.
 * - Pure read-only context: `lookup` and `query` delegate to the caller-provided
 *   DataProvider — tenant scope + permissions are preserved by the caller.
 *
 * This module does NOT mutate any data and is unrelated to the Action Engine
 * write path.
 */

import type { EntityRegistry } from "../entity/entity-registry";
import type { Actor } from "../types/action";
import type { EntityDefinition } from "../types/entity";
import type { OnchangeContext, OnchangeDefinition, OnchangeResult } from "../types/onchange";
import type { DataProvider, DataQueryOptions } from "./action-engine";

/** Maximum number of hook evaluations per onchange call (Spec 64 §5.2). */
export const MAX_CHAIN_DEPTH = 5;

/** Default per-hook timeout in milliseconds (Spec 64 §9.4). */
export const DEFAULT_COMPUTE_TIMEOUT_MS = 2000;

/** Structured result returned by the evaluator. */
export type OnchangeEvaluationResult = Required<OnchangeResult>;

/**
 * Callback evaluated before each `lookup` / `query` to decide whether the
 * current actor can read from the target entity. Returning `false` drops the
 * call and appends a structured warning to the evaluation result.
 *
 * The callback is intentionally minimal — it takes only the fields the
 * evaluator knows about. Full permission engines can capture additional state
 * in a closure when they construct the callback.
 */
export type OnchangeReadPermissionCheck = (args: {
  actor: Actor;
  tenantId: string | undefined;
  entity: string;
}) => Promise<boolean> | boolean;

/** Options for creating an onchange evaluator. */
export interface OnchangeEvaluatorOptions {
  entityRegistry: EntityRegistry;
  dataProvider: DataProvider;
  /** Override the default 2000 ms per-hook timeout (primarily for tests). */
  defaultTimeoutMs?: number;
  /** Override the default max chain depth (primarily for tests). */
  maxChainDepth?: number;
  /**
   * Optional read-permission check applied inside `lookup`/`query`. When the
   * check returns false, the data-provider call is skipped, the field is left
   * unset, and a structured warning is appended to the result.
   *
   * When omitted, ALL reads are allowed. The REST route is responsible for
   * logging a structured warning at startup so operators know permission
   * enforcement is not active (Spec 64 §4.3 — permission layer responsibility).
   */
  checkReadPermission?: OnchangeReadPermissionCheck;
}

/** Public evaluator interface. */
export interface OnchangeEvaluator {
  evaluate(args: OnchangeEvaluateArgs): Promise<OnchangeEvaluationResult>;
}

/** Arguments for a single evaluate() call. */
export interface OnchangeEvaluateArgs {
  entityName: string;
  changedField: string;
  values: Record<string, unknown>;
  actor: Actor;
  tenantId?: string;
}

// ── Internal helpers ─────────────────────────────────────────

/** Split a comma-key like `"a , b"` into `["a", "b"]`. */
function parseTriggerKey(key: string): string[] {
  return key
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Build a map from trigger field → OnchangeDefinition[] for a given entity.
 * When multiple comma-keys include the same field, all matching hooks fire.
 */
function indexHooks(entity: EntityDefinition): Map<string, OnchangeDefinition[]> {
  const index = new Map<string, OnchangeDefinition[]>();
  const onchange = entity.onchange;
  if (!onchange) return index;
  for (const [key, def] of Object.entries(onchange)) {
    for (const field of parseTriggerKey(key)) {
      const list = index.get(field) ?? [];
      list.push(def);
      index.set(field, list);
    }
  }
  return index;
}

/** Normalize a hook return value into a full OnchangeResult. */
function normalizeHookReturn(raw: OnchangeResult | Record<string, unknown>): OnchangeResult {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "updates" in raw &&
    typeof (raw as OnchangeResult).updates === "object"
  ) {
    const full = raw as OnchangeResult;
    return {
      updates: full.updates ?? {},
      warnings: Array.isArray(full.warnings) ? full.warnings : [],
    };
  }
  return { updates: raw as Record<string, unknown>, warnings: [] };
}

/**
 * Run the hook with a deadline. When the hook does not settle before the
 * deadline, resolve with an empty update set plus a timeout warning.
 */
async function runHookWithTimeout(
  hook: OnchangeDefinition,
  ctx: OnchangeContext,
  timeoutMs: number,
): Promise<OnchangeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<OnchangeResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        updates: {},
        warnings: [
          `Onchange hook for "${ctx.changedField}" exceeded ${timeoutMs} ms timeout and was skipped`,
        ],
      });
    }, timeoutMs);
  });

  const hookPromise = (async () => {
    const raw = await hook.compute(ctx);
    return normalizeHookReturn(raw);
  })();

  try {
    return await Promise.race([hookPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Apply the hook's declared `updates` allowlist to the returned record. Any
 * field not in the allowlist is dropped; a structured warning is emitted when
 * fields are dropped so UIs / logs can surface the discrepancy.
 */
function filterByAllowlist(
  hook: OnchangeDefinition,
  result: OnchangeResult,
  triggerField: string,
): OnchangeResult {
  const allowed = new Set(hook.updates);
  const filtered: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [field, value] of Object.entries(result.updates ?? {})) {
    if (allowed.has(field)) {
      filtered[field] = value;
    } else {
      dropped.push(field);
    }
  }
  const warnings = [...(result.warnings ?? [])];
  if (dropped.length > 0) {
    warnings.push(
      `Onchange hook for "${triggerField}" returned fields outside its updates allowlist and they were dropped: ${dropped.join(", ")}`,
    );
  }
  return { updates: filtered, warnings };
}

/**
 * Deduping warning sink used across a single `evaluate()` call. Callers supply
 * a dedup `key` plus the warning `message`; the first emission per key is
 * pushed into the backing array, subsequent emissions with the same key are
 * dropped. Used to collapse identical permission / lookup / query warnings
 * that would otherwise repeat across chained hooks.
 */
interface DedupedWarningSink {
  /** Push `message` unless `key` was already pushed during this call. */
  push(key: string, message: string): void;
  /** Raw warning array for evaluator-owned (non-deduped) warnings. */
  readonly warnings: string[];
}

function createDedupedWarningSink(backing: string[]): DedupedWarningSink {
  const seen = new Set<string>();
  return {
    push(key, message) {
      if (seen.has(key)) return;
      seen.add(key);
      backing.push(message);
    },
    warnings: backing,
  };
}

/**
 * Build the context object passed to `hook.compute`. The context exposes only
 * read-level helpers; it MUST NOT leak any DataProvider write methods.
 *
 * When `checkReadPermission` is supplied, each `lookup`/`query` first asks the
 * caller whether the current actor may read the target entity. On denial the
 * data-provider call is skipped and a structured warning is pushed into
 * `warningSink`, which the evaluator merges into the final result.
 *
 * `warningSink` must be a shared `DedupedWarningSink` for the whole
 * `evaluate()` call so that identical permission denials / lookup failures
 * emitted by chained hooks collapse into a single warning (Spec 64 §9.1).
 */
function buildContext(options: {
  changedField: string;
  values: Record<string, unknown>;
  actor: Actor;
  tenantId: string | undefined;
  dataProvider: DataProvider;
  checkReadPermission?: OnchangeReadPermissionCheck;
  warningSink: DedupedWarningSink;
}): OnchangeContext {
  const { changedField, values, actor, tenantId, dataProvider, checkReadPermission, warningSink } =
    options;
  const queryOptions: DataQueryOptions = tenantId ? { tenantId } : {};

  async function ensureReadable(entity: string): Promise<boolean> {
    if (!checkReadPermission) return true;
    try {
      const allowed = await checkReadPermission({ actor, tenantId, entity });
      if (!allowed) {
        // Collapse repeated denials of the same entity into a single warning
        // so chained hooks don't spam the UI with identical messages.
        warningSink.push(
          `permission-denied:${entity}`,
          `Access to "${entity}" denied for current actor`,
        );
      }
      return allowed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warningSink.push(
        `permission-check-failed:${entity}`,
        `Read-permission check for "${entity}" failed: ${message}`,
      );
      return false;
    }
  }

  return {
    changedField,
    value: values[changedField],
    values,
    actor,
    tenantId,
    async lookup(entity, id, field) {
      if (!(await ensureReadable(entity))) return undefined;
      try {
        const record = await dataProvider.get(entity, id, queryOptions);
        if (!record) return undefined;
        return record[field];
      } catch (err) {
        // Spec 64 §9.1 — `lookup` must never throw from the hook author's
        // perspective. But silently swallowing DB / tenant / timeout errors is
        // dangerous, so surface them as a structured warning. Dedup by
        // (entity, message) so repeated identical failures across chained
        // hooks collapse into a single warning.
        const message = err instanceof Error ? err.message : String(err);
        warningSink.push(
          `lookup-failed:${entity}:${message}`,
          `Lookup on "${entity}" failed: ${message}`,
        );
        return undefined;
      }
    },
    async query(entity, filter) {
      if (!(await ensureReadable(entity))) return [];
      try {
        return await dataProvider.query(entity, filter, queryOptions);
      } catch (err) {
        // Same contract as `lookup`: never throw, but emit a deduped warning.
        const message = err instanceof Error ? err.message : String(err);
        warningSink.push(
          `query-failed:${entity}:${message}`,
          `Query on "${entity}" failed: ${message}`,
        );
        return [];
      }
    },
  };
}

// ── Factory ─────────────────────────────────────────────────

/**
 * Create an onchange evaluator bound to an EntityRegistry + DataProvider.
 *
 * The returned `evaluate()` runs the BFS algorithm from Spec 64 §5 and returns
 * the final accumulated updates plus any warnings (including depth-cap,
 * timeout, and allowlist warnings).
 */
export function createOnchangeEvaluator(options: OnchangeEvaluatorOptions): OnchangeEvaluator {
  const {
    entityRegistry,
    dataProvider,
    defaultTimeoutMs = DEFAULT_COMPUTE_TIMEOUT_MS,
    maxChainDepth = MAX_CHAIN_DEPTH,
    checkReadPermission,
  } = options;

  async function evaluate(args: OnchangeEvaluateArgs): Promise<OnchangeEvaluationResult> {
    const { entityName, changedField, values, actor, tenantId } = args;

    const entity = entityRegistry.get(entityName);
    if (!entity) {
      throw new OnchangeEvaluatorError(`Entity "${entityName}" not found`, "ENTITY_NOT_FOUND");
    }
    if (!entity.onchange || Object.keys(entity.onchange).length === 0) {
      throw new OnchangeEvaluatorError(
        `Entity "${entityName}" has no onchange definition`,
        "ENTITY_HAS_NO_ONCHANGE",
      );
    }
    if (!(changedField in entity.fields)) {
      throw new OnchangeEvaluatorError(
        `Field "${changedField}" is not defined on entity "${entityName}"`,
        "FIELD_UNKNOWN",
      );
    }

    const hookIndex = indexHooks(entity);

    // Spec 64 §4.1 — 404 case: entity has an onchange map but nothing registered
    // for the triggering field. Surface as a typed error so the REST layer can
    // distinguish this from a successful "no-op" and return the correct status.
    if (!hookIndex.has(changedField)) {
      throw new OnchangeEvaluatorError(
        `Entity "${entityName}" has no onchange hook for field "${changedField}"`,
        "NO_HOOK_FOR_FIELD",
      );
    }

    // Start with a mutable copy so chained hooks can observe prior updates.
    const mergedValues: Record<string, unknown> = { ...values };
    const accumulated: Record<string, unknown> = {};
    const warnings: string[] = [];
    // Single deduping sink shared across every hook in this evaluate() call.
    // Permission denials and lookup/query failures dedup by entity + message
    // so chained hooks collapse repeated warnings into one.
    const warningSink = createDedupedWarningSink(warnings);
    const visited = new Set<string>();
    const queue: string[] = [changedField];
    let evaluations = 0;

    while (queue.length > 0) {
      const field = queue.shift();
      if (field === undefined) break;
      if (visited.has(field)) continue;
      visited.add(field);

      const hooks = hookIndex.get(field);
      if (!hooks || hooks.length === 0) continue;

      for (const hook of hooks) {
        if (evaluations >= maxChainDepth) {
          warnings.push(
            `Onchange chain depth limit reached (${maxChainDepth}). Some dependent fields may not be updated.`,
          );
          return { updates: accumulated, warnings };
        }
        evaluations++;

        const ctx = buildContext({
          changedField: field,
          values: mergedValues,
          actor,
          tenantId,
          dataProvider,
          checkReadPermission,
          warningSink,
        });

        let result: OnchangeResult;
        try {
          const timeoutMs = hook.timeout ?? defaultTimeoutMs;
          result = await runHookWithTimeout(hook, ctx, timeoutMs);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`Onchange hook for "${field}" threw an error and was skipped: ${message}`);
          continue;
        }

        const filtered = filterByAllowlist(hook, result, field);
        for (const w of filtered.warnings ?? []) warnings.push(w);

        for (const [updatedField, value] of Object.entries(filtered.updates)) {
          accumulated[updatedField] = value;
          mergedValues[updatedField] = value;
          // Enqueue cascaded field only if it wasn't already processed (cycle safety).
          if (!visited.has(updatedField)) {
            queue.push(updatedField);
          }
        }
      }
    }

    return { updates: accumulated, warnings };
  }

  return { evaluate };
}

// ── Errors ──────────────────────────────────────────────────

/**
 * Structured error emitted when an onchange evaluation cannot proceed due to
 * bad input (unknown entity / field, no onchange map, etc.). The REST route
 * maps each `code` to an HTTP status.
 */
/** Discriminator for all structured evaluator errors. */
export type OnchangeEvaluatorErrorCode =
  | "ENTITY_NOT_FOUND"
  | "ENTITY_HAS_NO_ONCHANGE"
  | "FIELD_UNKNOWN"
  | "NO_HOOK_FOR_FIELD";

export class OnchangeEvaluatorError extends Error {
  readonly code: OnchangeEvaluatorErrorCode;
  constructor(message: string, code: OnchangeEvaluatorErrorCode) {
    super(message);
    this.name = "OnchangeEvaluatorError";
    this.code = code;
  }
}
