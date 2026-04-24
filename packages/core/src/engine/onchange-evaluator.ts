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
 *   with a warning, late-arriving updates from the background hook promise are
 *   dropped via a `timedOut` guard (Finding 3), and the chain continues.
 * - Sanitized warning surface: raw internal errors (SQL text, stack fragments,
 *   lookup internals) are NEVER echoed into the client-visible warnings array.
 *   They are logged through the runtime `Logger` at `warn` level (Finding 4).
 * - Defensive cloning: `ctx.values` and `lookup`/`query` results are cloned at
 *   the evaluator/hook boundary so a misbehaving hook cannot mutate another
 *   hook's view or the shared accumulator (Finding 5).
 * - Pure read-only context: `lookup` and `query` delegate to the caller-provided
 *   DataProvider — tenant scope + permissions are preserved by the caller.
 *
 * This module does NOT mutate any data and is unrelated to the Action Engine
 * write path.
 */

import type { EntityRegistry } from "../entity/entity-registry";
import { consoleLogger } from "../observability/console-logger";
import type { Actor } from "../types/action";
import type { Logger } from "../types/logger";
import type { OnchangeResult } from "../types/onchange";
import type { DataProvider } from "./action-engine";
import {
  buildContext,
  createDedupedWarningSink,
  createRevocableWarningSink,
  filterByAllowlist,
  indexHooks,
  type OnchangeReadPermissionCheck,
  runHookWithTimeout,
  type TimedHookOutcome,
} from "./onchange-evaluator-internals";

// Re-export the public permission-check type so consumers keep their existing
// `import { OnchangeReadPermissionCheck } from "@linchkit/core/server"` paths.
export type { OnchangeReadPermissionCheck } from "./onchange-evaluator-internals";

/** Maximum number of hook evaluations per onchange call (Spec 64 §5.2). */
export const MAX_CHAIN_DEPTH = 5;

/** Default per-hook timeout in milliseconds (Spec 64 §9.4). */
export const DEFAULT_COMPUTE_TIMEOUT_MS = 2000;

/** Structured result returned by the evaluator. */
export type OnchangeEvaluationResult = Required<OnchangeResult>;

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
  /**
   * Structured logger for diagnostic output. Raw internal errors (SQL text,
   * stack fragments, etc.) are logged here at `warn` level so operators can
   * debug, while the user-facing `warnings` array contains only sanitized
   * messages. Defaults to the package console logger.
   */
  logger?: Logger;
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
    logger = consoleLogger,
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

        // Finding 3 (late-warning guard) — each hook gets its own revocable
        // wrapper around the shared deduped sink. The sink is only "live" for
        // the synchronous span of the hook's execution: `revoke()` runs
        // unconditionally after `runHookWithTimeout` returns (success,
        // timeout, or throw). That way, even if a hook's `compute` starts a
        // background promise that isn't awaited and later tries to push a
        // warning via `ctx.lookup` / `ctx.query` / permission checks, the
        // late push is dropped from the client-visible warnings array and
        // rerouted to `Logger.warn`.
        const hookName = `${entityName}.onchange[${field}]`;
        const timeoutMs = hook.timeout ?? defaultTimeoutMs;
        const revocable = createRevocableWarningSink(warningSink, logger, hookName);
        const ctx = buildContext({
          changedField: field,
          values: mergedValues,
          actor,
          tenantId,
          dataProvider,
          checkReadPermission,
          warningSink: revocable.sink,
          logger,
        });

        let outcome: TimedHookOutcome;
        try {
          outcome = await runHookWithTimeout(hook, ctx, timeoutMs);
        } catch (err) {
          // Finding 4 — sanitize the user-facing message and log the real
          // error detail through the runtime logger.
          const rawMessage = err instanceof Error ? err.message : String(err);
          logger.warn("onchange: hook threw", {
            entity: entityName,
            field,
            actor: actor.id,
            tenantId,
            error: rawMessage,
          });
          warnings.push(`Onchange hook for "${field}" threw an error and was skipped`);
          // Best-effort cleanup: if the hook threw synchronously after capturing
          // ctx, also revoke its sink so any lingering async work cannot push
          // late warnings through the closure.
          revocable.revoke();
          continue;
        }

        // Finding 3 — if the hook timed out, DROP its late-arriving result.
        // Only the synthesized timeout warning survives; no updates, no
        // hook-returned warnings, nothing that would mutate the shared
        // accumulator or re-enter the BFS queue.
        if (outcome.timedOut) {
          // Revoke BEFORE continuing the BFS so any still-in-flight
          // lookup/query/permission-check from the timed-out hook cannot push
          // a late warning into the client-visible array.
          revocable.revoke();
          // Blocker 2 — operator observability. Log the timeout with full
          // context so ops can diagnose runaway hooks. This complements the
          // sanitized client-facing warning already emitted by
          // `runHookWithTimeout`.
          logger.warn("onchange: hook timed out", {
            hook: hookName,
            entity: entityName,
            field,
            actor: actor.id,
            tenantId,
            timeoutMs,
          });
          for (const w of outcome.result.warnings ?? []) warnings.push(w);
          continue;
        }

        const filtered = filterByAllowlist(hook, outcome.result, field);
        // Revoke the per-hook sink on the success path too: a hook's
        // `compute` might have started an un-awaited background promise that
        // later tries to push a warning. The synchronous portion is done, so
        // any late push is by definition out of scope and must be dropped.
        revocable.revoke();
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
