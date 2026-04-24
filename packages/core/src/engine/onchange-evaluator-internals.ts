/**
 * Internal helpers for the onchange evaluator (Spec 64).
 *
 * These are implementation details of `onchange-evaluator.ts` and are kept in
 * a separate file purely to keep each module under the repo's 500-line
 * soft target. Nothing here is part of the public API — do not import from
 * outside `engine/onchange-evaluator*.ts`.
 */

import type { Actor } from "../types/action";
import type { EntityDefinition } from "../types/entity";
import type { Logger } from "../types/logger";
import type { OnchangeContext, OnchangeDefinition, OnchangeResult } from "../types/onchange";
import type { DataProvider, DataQueryOptions } from "./action-engine";

export type OnchangeReadPermissionCheck = (args: {
  actor: Actor;
  tenantId: string | undefined;
  entity: string;
}) => Promise<boolean> | boolean;

// ── Parsing / indexing ──────────────────────────────────────

/** Split a comma-key like `"a , b"` into `["a", "b"]`. */
export function parseTriggerKey(key: string): string[] {
  return key
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Build a map from trigger field → OnchangeDefinition[] for a given entity.
 * When multiple comma-keys include the same field, all matching hooks fire.
 */
export function indexHooks(entity: EntityDefinition): Map<string, OnchangeDefinition[]> {
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

// ── Hook result normalization + allowlist filtering ─────────

/** Normalize a hook return value into a full OnchangeResult. */
export function normalizeHookReturn(raw: OnchangeResult | Record<string, unknown>): OnchangeResult {
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
 * Apply the hook's declared `updates` allowlist to the returned record. Any
 * field not in the allowlist is dropped; a structured warning is emitted when
 * fields are dropped so UIs / logs can surface the discrepancy.
 */
export function filterByAllowlist(
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

// ── Deduped warning sink ────────────────────────────────────

/**
 * Deduping warning sink used across a single `evaluate()` call. Callers supply
 * a dedup `key` plus the warning `message`; the first emission per key is
 * pushed into the backing array, subsequent emissions with the same key are
 * dropped. Used to collapse identical permission / lookup / query warnings
 * that would otherwise repeat across chained hooks.
 */
export interface DedupedWarningSink {
  /** Push `message` unless `key` was already pushed during this call. */
  push(key: string, message: string): void;
  /** Raw warning array for evaluator-owned (non-deduped) warnings. */
  readonly warnings: string[];
}

export function createDedupedWarningSink(backing: string[]): DedupedWarningSink {
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

// ── Timed hook execution (Finding 3) ────────────────────────

/**
 * Result of a timed hook invocation. When `timedOut` is true the caller MUST
 * discard `result` and not apply it to shared state — late-arriving updates
 * from a background hook promise must not mutate the accumulator after the
 * deadline has fired (Finding 3 / Spec 64 §9.4).
 */
export interface TimedHookOutcome {
  result: OnchangeResult;
  timedOut: boolean;
}

/**
 * Run the hook with a deadline. When the hook does not settle before the
 * deadline, resolve with an empty update set plus a timeout warning and set
 * `timedOut = true`. The late-arriving hook promise is swallowed so any
 * eventual update it would have produced is dropped rather than racing to
 * mutate the shared evaluation state.
 *
 * This is the `timedOut` guard approach (Finding 3b) rather than an
 * AbortController (3a). The public `OnchangeContext` shape stays additive —
 * existing hooks do not need to cooperate with any abort signal to get
 * correct timeout semantics.
 */
export async function runHookWithTimeout(
  hook: OnchangeDefinition,
  ctx: OnchangeContext,
  timeoutMs: number,
): Promise<TimedHookOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didTimeOut = false;

  const timeoutPromise = new Promise<TimedHookOutcome>((resolve) => {
    timer = setTimeout(() => {
      didTimeOut = true;
      resolve({
        result: {
          updates: {},
          warnings: [
            `Onchange hook for "${ctx.changedField}" exceeded ${timeoutMs} ms timeout and was skipped`,
          ],
        },
        timedOut: true,
      });
    }, timeoutMs);
  });

  const hookPromise = (async (): Promise<TimedHookOutcome> => {
    const raw = await hook.compute(ctx);
    return { result: normalizeHookReturn(raw), timedOut: false };
  })();

  // Silence unhandled-rejection noise from the background promise if the hook
  // still eventually throws after we've already resolved via the timeout path.
  hookPromise.catch(() => {
    /* late hook rejection — result is already dropped via the timedOut guard */
  });

  try {
    const outcome = await Promise.race([hookPromise, timeoutPromise]);
    // Defensive: if the race was won by hookPromise but the timeout flag was
    // already flipped (extremely tight race), prefer the timeout outcome so
    // late-arriving state cannot leak through.
    if (didTimeOut) {
      return {
        result: {
          updates: {},
          warnings: [
            `Onchange hook for "${ctx.changedField}" exceeded ${timeoutMs} ms timeout and was skipped`,
          ],
        },
        timedOut: true,
      };
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── Defensive cloning (Finding 5) ───────────────────────────

/**
 * Deep-clone a value before handing it to a hook's `compute()` so a
 * misbehaving hook cannot mutate another hook's view, the shared merged
 * values, or data that was returned from `lookup`/`query`. `structuredClone`
 * is built-in in Bun + Node 17+ and handles Date / Map / Set / TypedArray
 * correctly, unlike a JSON round-trip.
 *
 * We clone only at the boundary between the evaluator and the hook — NOT
 * inside the DataProvider call itself (cloning raw provider results is
 * expensive and pointless). See Finding 5.
 */
export function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // Fall back to identity when a value cannot be cloned (e.g. functions,
    // class instances with unsupported slots). Mutation safety is a defense
    // in depth measure — losing it here is acceptable rather than throwing.
    return value;
  }
}

// ── Hook context builder ────────────────────────────────────

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
 *
 * Raw error messages from permission check failures and `lookup`/`query`
 * data-provider errors are NEVER echoed into the user-facing warnings array
 * (Finding 4). They are logged through the caller-supplied `Logger` at
 * `warn` level with full context; the client sees only a sanitized message.
 */
export function buildContext(options: {
  changedField: string;
  values: Record<string, unknown>;
  actor: Actor;
  tenantId: string | undefined;
  dataProvider: DataProvider;
  checkReadPermission?: OnchangeReadPermissionCheck;
  warningSink: DedupedWarningSink;
  logger: Logger;
}): OnchangeContext {
  const {
    changedField,
    values,
    actor,
    tenantId,
    dataProvider,
    checkReadPermission,
    warningSink,
    logger,
  } = options;
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
      // Finding 4 — do NOT echo raw err.message into user-facing warnings.
      // Log the real detail through the runtime logger and emit a sanitized
      // entry to the client.
      logger.warn("onchange: read-permission check failed", {
        entity,
        actor: actor.id,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      warningSink.push(
        `permission-check-failed:${entity}`,
        `permission check failed for "${entity}"`,
      );
      return false;
    }
  }

  return {
    changedField,
    value: values[changedField],
    // Finding 5 — expose a defensive clone so a misbehaving hook cannot
    // mutate the shared evaluation state observed by subsequent hooks.
    values: safeClone(values),
    actor,
    tenantId,
    async lookup(entity, id, field) {
      if (!(await ensureReadable(entity))) return undefined;
      try {
        const record = await dataProvider.get(entity, id, queryOptions);
        if (!record) return undefined;
        // Finding 5 — clone at the evaluator/hook boundary so hooks cannot
        // corrupt provider-cached data or another hook's view of the same row.
        return safeClone(record[field]);
      } catch (err) {
        // Spec 64 §9.1 — `lookup` must never throw from the hook author's
        // perspective. But silently swallowing DB / tenant / timeout errors is
        // dangerous, so surface them as a sanitized structured warning and
        // log the real error for operators (Finding 4).
        const rawMessage = err instanceof Error ? err.message : String(err);
        logger.warn("onchange: lookup failed", {
          entity,
          id,
          field,
          actor: actor.id,
          tenantId,
          error: rawMessage,
        });
        warningSink.push(`lookup-failed:${entity}`, `lookup on "${entity}" failed`);
        return undefined;
      }
    },
    async query(entity, filter) {
      if (!(await ensureReadable(entity))) return [];
      try {
        const rows = await dataProvider.query(entity, filter, queryOptions);
        // Finding 5 — clone the array so hooks cannot mutate provider state.
        return safeClone(rows);
      } catch (err) {
        // Same contract as `lookup`: never throw; emit a sanitized warning
        // and log the raw error via the runtime logger (Finding 4).
        const rawMessage = err instanceof Error ? err.message : String(err);
        logger.warn("onchange: query failed", {
          entity,
          filter,
          actor: actor.id,
          tenantId,
          error: rawMessage,
        });
        warningSink.push(`query-failed:${entity}`, `query on "${entity}" failed`);
        return [];
      }
    },
  };
}
