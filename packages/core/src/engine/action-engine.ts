/**
 * Action Engine
 *
 * Manages action registration and execution.
 * Actions are the sole write entry point of the system.
 * Execution follows the unified execution contract (see spec 39).
 */

import { ConfigRegistry } from "../config/config-registry";
import { DEFAULT_EXECUTION_META_MASKED_KEYS } from "../config/system-schemas";
import type { EntityRegistry } from "../entity/entity-registry";
import type { EventBus } from "../event/event-bus";
import type { MetricsCollector } from "../observability/metrics";
import { noopMetricsCollector } from "../observability/metrics";
import { getCurrentTrace } from "../observability/trace-context";
import { createTenantAwareDataProvider } from "../security/tenant-isolation";
import type { ActionContext, ActionResult, Actor } from "../types/action";
import type { AIService } from "../types/ai";
import type { FieldDefinition } from "../types/entity";
import type { ExecutionLogEntry, ExecutionLogger } from "../types/execution-log";
import type { ExecutionMeta } from "../types/execution-meta";
import {
  createExecutionMeta,
  extendExecutionMeta,
  extractAdapterSystemKeys,
  MetaSizeError,
  redactMetaForLog,
} from "../types/execution-meta";
import type { Logger } from "../types/logger";
import {
  checkFieldLocks,
  type FieldLockViolation,
  LockPreflightError,
  LockViolationError,
} from "./field-lock-checker";
import type { StateMachine } from "./state-machine";
import { canTransition, getAvailableActions } from "./state-machine";

export { ActionRegistry } from "./action-registry";

import {
  checkActorType,
  generateExecutionId,
  isExposed,
  resolveFieldExpression,
  runPreValidation,
  validateInput,
} from "./action-helpers";
import { ActionRegistry } from "./action-registry";
import { hashBehaviorAffectingMeta } from "./meta-keys";

// Framework-reserved `_`-prefixed system meta keys are defined as
// `FRAMEWORK_RESERVED_META_KEYS` in `../types/execution-meta` so they are
// shared with ApprovalEngine (which must agree on the same boundary when
// partitioning persisted meta on suspend / replay — Spec 65 §3.3, #230).

// ── DataProvider interface ──────────────────────────────────

/** Options for data queries — tenant isolation, soft-delete control, and locale */
export interface DataQueryOptions {
  tenantId?: string;
  includeDeleted?: boolean;
  /** Locale for resolving translatable fields (e.g., "zh-CN", "en") */
  locale?: string;
}

/** Abstraction for data access — injected into the executor for testability */
export interface DataProvider {
  get(schema: string, id: string, options?: DataQueryOptions): Promise<Record<string, unknown>>;
  query(
    schema: string,
    filter: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Array<Record<string, unknown>>>;
  create(schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(
    schema: string,
    id: string,
    data: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<Record<string, unknown>>;
  delete(schema: string, id: string, options?: DataQueryOptions): Promise<void>;
  count(
    schema: string,
    filter?: Record<string, unknown>,
    options?: DataQueryOptions,
  ): Promise<number>;
}

// ── Execution channel (for exposure checks) ─────────────────

export type ExecutionChannel = "http" | "mcp" | "cli" | "ui" | "internal";

// ── Execute options ─────────────────────────────────────────

export interface ExecuteOptions {
  channel?: ExecutionChannel;
  /** Skip exposure check (already handled by CommandLayer built-in exposure slot) */
  skipExposureCheck?: boolean;
  /**
   * @deprecated Group authorization no longer runs inside the Action Engine
   * (issue #125). The executor ignores this flag; permissions are enforced
   * exclusively by the CommandLayer "permission" slot. Retained for source
   * compatibility with older CommandLayer middleware that still sets it.
   */
  skipPermissionCheck?: boolean;
  /** Tenant ID resolved by CommandLayer */
  tenantId?: string;
  /** Locale for resolving translatable fields on read */
  locale?: string;
  /**
   * Rule names to skip during re-execution after approval.
   * The CommandLayer / caller is responsible for checking this list
   * before evaluating rules, so approved actions don't re-trigger
   * the same approval flow.
   */
  skipRules?: string[];
  /** Approval ID that authorized this re-execution */
  approvalId?: string;
  /** Include soft-deleted records in data operations (used by restore action) */
  includeDeleted?: boolean;
  /** Idempotency key — if provided and an execution with this key already succeeded, return cached result */
  idempotencyKey?: string;
  /** Internal: current recursion depth for child action execution */
  _depth?: number;
  /** Internal: transactional data provider from parent action (shared transaction) */
  _txDataProvider?: DataProvider;
  /** Internal: parent's pending events array for shared transaction */
  _parentPendingEvents?: PendingEvent[];
  /**
   * Execution metadata propagated through the execution chain (Spec 65).
   *
   * Accepts either a pre-built `ExecutionMeta` (how the CommandLayer and the
   * ActionEngine itself pass meta across nested calls) OR a plain record of
   * raw key-value pairs (the natural call shape from direct-executor tests
   * and internal callers). Plain records are normalized with
   * `createExecutionMeta` at ingestion. Without this normalization, passing
   * `{ meta: { source_view: "queue" } }` would break `ctx.meta.get(...)` at
   * runtime with "x is not a function".
   */
  meta?: ExecutionMeta | Record<string, unknown>;
  /**
   * Framework-trusted system meta keys (Spec 65 §3.3, §4.4).
   *
   * Adapters set channel-specific system keys here (e.g. MCP injects
   * `_mcp_client_id` after authenticating the caller). Unlike `meta`, keys
   * placed here BYPASS the `_`-prefix strip applied to external input — they
   * are merged into `rootSystemDefaults` server-side. Values are still
   * filtered to JSON-serializable primitives by the meta factory.
   *
   * Reserved framework keys (`_channel`, `_execution_id`, `_depth`,
   * `_source_action`) cannot be overridden — the engine's own assignments
   * always win.
   */
  systemMeta?: Record<string, unknown>;
}

// ── ActionExecutor ──────────────────────────────────────────

export interface ActionExecutor {
  readonly registry: ActionRegistry;

  execute<T = unknown>(
    actionName: string,
    input: Record<string, unknown>,
    actor: Actor,
    options?: ExecuteOptions,
  ): Promise<ActionResult<T>>;
}

// ── Transactional event collection ──────────────────────────

/** Data needed to persist an event within a transaction */
export interface PendingEvent {
  type: string;
  payload: Record<string, unknown>;
  tenantId?: string;
  sourceAction?: string;
  sourceExecutionId?: string;
  /** Trace ID for restoring the trace chain in OutboxWorker */
  traceId?: string;
  /**
   * ExecutionMeta from the action that emitted this event (Spec 65 §7).
   * Delivery-time only — NOT written to the events table by the
   * Transactional Outbox (the persistence layer ignores this field).
   */
  meta?: ExecutionMeta;
}

/**
 * Abstraction for running action handlers within database transactions.
 * Implementations handle DB-specific transaction management.
 *
 * When a TransactionManager is provided, the executor wraps handler
 * execution in a transaction. After the handler succeeds, pendingEvents
 * collected via ctx.emit() are written to the events table within the
 * same transaction — guaranteeing atomicity (Transactional Outbox pattern).
 */
export interface TransactionManager {
  /**
   * Execute fn within a database transaction.
   * @param fn - Receives a transactional DataProvider; all data ops use the same tx.
   * @param pendingEvents - Events collected during handler execution; persisted in the same tx.
   * @returns The value returned by fn.
   */
  runInTransaction<T>(
    fn: (txDataProvider: DataProvider) => Promise<T>,
    pendingEvents: PendingEvent[],
  ): Promise<T>;
}

// ── Factory ─────────────────────────────────────────────────

export interface ActionExecutorOptions {
  dataProvider: DataProvider;
  /** Transaction manager for wrapping handler execution in DB transactions.
   *  When provided, actions run within a transaction and events are persisted atomically. */
  transactionManager?: TransactionManager;
  stateMachine?: StateMachine;
  executionLogger?: ExecutionLogger;
  /** AI service instance — optional, noop if not provided */
  aiService?: AIService;
  /** Config registry — injected into ActionContext for type-safe config access.
   *  Falls back to an empty registry when omitted (e.g. in tests). */
  configRegistry?: ConfigRegistry;
  /** Metrics collector — optional, defaults to noopMetricsCollector (zero overhead) */
  metrics?: MetricsCollector;
  /** Logger instance — injected into ActionContext for handler-level logging.
   *  Falls back to a silent noop logger when omitted. */
  logger?: Logger;
  /** Event bus for emitting action lifecycle events (action.succeeded, action.failed) */
  eventBus?: EventBus;
  /** Names of registered capabilities — enables ctx.hasCapability() for weak dependency checks */
  capabilityNames?: ReadonlySet<string>;
  /**
   * EntityRegistry used by the field-lock checker (Spec 63 Phase 1). When
   * omitted the lock check is skipped — immutable / lockWhen / lockAllWhen
   * enforcement requires entity metadata. Tests that don't care about locking
   * can omit this; production wiring (Runtime) always supplies it.
   */
  entityRegistry?: EntityRegistry;
}

/**
 * Duck-type check: does `value` look like an {@link ExecutionMeta}? The
 * public ExecuteOptions.meta accepts either a pre-built ExecutionMeta (how
 * the CommandLayer + nested ctx.execute pass it) or a plain record (natural
 * external call shape). We detect the former by the presence of the typed
 * accessor methods rather than an `instanceof` check so third-party
 * implementations (e.g., future Phase 2 subclasses) still work.
 */
function isExecutionMeta(value: unknown): value is ExecutionMeta {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.get === "function" &&
    typeof candidate.has === "function" &&
    typeof candidate.require === "function" &&
    typeof candidate.toJSON === "function"
  );
}

/**
 * Extend an incoming ExecutionMeta with system defaults ONLY for keys the
 * parent has not already set. Prevents a child execution from clobbering
 * root-level `_execution_id`, while still backfilling it when a parent meta
 * happens to arrive without one.
 */
function fillMissingSystemKeys(
  meta: ExecutionMeta,
  systemDefaults: Record<string, unknown>,
): ExecutionMeta {
  const missing: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(systemDefaults)) {
    if (!meta.has(k)) missing[k] = v;
  }
  if (Object.keys(missing).length === 0) return meta;
  return extendExecutionMeta(meta, {}, missing);
}

/**
 * Create an ActionExecutor instance.
 *
 * The executor follows the simplified M0b execution flow:
 * 1. Look up action definition
 * 2. Exposure check
 * 3. Actor-type check
 * 4. Input validation
 * 4b. Field-lock check (Spec 63 — immutable / lockWhen / lockAllWhen)
 * 5. Pre-validation (validate.required, validate.custom)
 * 6. State transition check
 * 7. Execute (declarative or handler)
 * 8. Return ActionResult
 */
export function createActionExecutor(options: ActionExecutorOptions): ActionExecutor {
  const registry = new ActionRegistry();
  const {
    dataProvider,
    transactionManager,
    stateMachine,
    executionLogger,
    aiService,
    configRegistry,
    metrics = noopMetricsCollector,
    logger: injectedLogger,
    eventBus,
    capabilityNames = new Set<string>(),
    entityRegistry,
  } = options;

  /** Silent noop logger — used when no logger is injected */
  const noopFn = () => {};
  const noopLogger: Logger = { debug: noopFn, info: noopFn, warn: noopFn, error: noopFn };
  const logger: Logger = injectedLogger ?? noopLogger;

  /**
   * Resolve the configured `system:execution.meta.maskedKeys` list once at
   * executor-construction time. Falls back to the built-in default list when
   * no ConfigRegistry was injected (test path) — the redaction guarantee
   * (Spec 65 §10.3) must hold regardless of whether the runtime configured
   * the namespace explicitly.
   *
   * Resolved at construction (not per-execute) because the registry is
   * immutable after creation — re-reading on every call would just be lost
   * work.
   */
  const maskedKeys: ReadonlyArray<string> = (() => {
    if (!configRegistry?.has("system:execution")) {
      return DEFAULT_EXECUTION_META_MASKED_KEYS;
    }
    const cfg = configRegistry.get<{ meta: { maskedKeys: ReadonlyArray<string> } }>(
      "system:execution",
    );
    return cfg.meta.maskedKeys;
  })();

  /**
   * Build and log an execution entry. Applies meta redaction (Spec 65 §10.3)
   * at the log boundary so the persisted entry replaces configured sensitive
   * keys with `"***"`. The in-memory `metaSnapshot` callers pass in remains
   * plaintext — only the value handed to the logger is redacted.
   */
  async function logExecution(
    entry: Omit<ExecutionLogEntry, "completedAt" | "duration"> & { startedAt: Date },
  ): Promise<void> {
    if (!executionLogger) return;
    const completedAt = new Date();
    const duration = completedAt.getTime() - entry.startedAt.getTime();
    const redactedMeta = redactMetaForLog(entry.meta, maskedKeys);
    await executionLogger.log({
      ...entry,
      meta: redactedMeta,
      completedAt,
      duration,
    } as ExecutionLogEntry);
  }

  /** Maximum recursion depth for child action execution */
  const MAX_CHILD_DEPTH = 10;

  async function execute<T = unknown>(
    actionName: string,
    input: Record<string, unknown>,
    actor: Actor,
    execOptions?: ExecuteOptions,
  ): Promise<ActionResult<T>> {
    const executionId = generateExecutionId();
    const startedAt = new Date();
    const currentDepth = execOptions?._depth ?? 0;
    // Default channel matches the value used by the rest of the executor —
    // also used for stamping `_channel` into meta.
    const channel: ExecutionChannel = execOptions?.channel ?? "internal";

    // Resolve execution meta. Spec 65 §9: every execution log entry — success,
    // validation failure, recursion-check rejection, etc. — records the meta
    // snapshot for audit / debugging / analytics. Resolving meta UP FRONT (before
    // the depth check, action lookup, and validation steps) lets every
    // `logExecution(...)` call thread `meta: metaSnapshot` through without
    // reaching for the not-yet-built ExecutionMeta. Resolution itself can fail
    // with `MetaSizeError` (oversize plain record at root, or oversize parent
    // meta arriving via a duck-typed implementation); we surface that as a
    // failed ActionResult so direct-executor callers see the same shape as
    // other failures regardless of entry point.
    //
    // ### Root-vs-nested trust boundary (Gemini PR #201 review)
    //
    // At `currentDepth === 0` the provided meta comes from an **untrusted**
    // external surface — a direct-executor call, a CommandLayer forward, a
    // duck-typed ExecutionMeta, whatever. We always re-run through
    // `createExecutionMeta` with the raw snapshot so:
    //  1. `_`-prefixed keys are stripped (external callers cannot spoof
    //     `_channel`, `_execution_id`, etc.).
    //  2. Non-JSON-serializable values are filtered.
    //  3. Framework-owned `rootSystemDefaults` always win.
    //
    // At `currentDepth > 0` the provided meta was built by the engine itself
    // via `extendExecutionMeta` in `ctx.execute`, so it is framework-trusted;
    // passing it through unchanged preserves the parent's `_execution_id`
    // and other system keys across the chain.
    //
    // `_execution_id` is the ROOT execution record id (Spec 65 §4.4 — keyed
    // against ExecutionLogger.getById), NOT a tracing id. ActionEngine owns
    // its assignment.
    // Adapter-supplied system keys (Spec 65 §3.3) — e.g. `_mcp_client_id`
    // injected by the MCP adapter after authenticating the caller. Reserved
    // framework keys are filtered out (see `FRAMEWORK_RESERVED_META_KEYS`)
    // so the engine's own assignments always win.
    //
    // ApprovalEngine.approve() forwards the persisted `actorSystemMeta`
    // through this same channel on replay so adapter attribution survives
    // suspend / replay (#230).
    // Reuse the shared `extractAdapterSystemKeys` helper so the framework-
    // reserved key boundary stays consistent with ApprovalEngine's persist
    // path (single source of truth in execution-meta.ts).
    const providedSystemMeta = execOptions?.systemMeta;
    const adapterSystemMeta: Record<string, unknown> =
      (providedSystemMeta && currentDepth === 0
        ? extractAdapterSystemKeys(providedSystemMeta)
        : undefined) ?? {};

    const rootSystemDefaults: Record<string, unknown> = {
      ...adapterSystemMeta,
      _channel: channel,
      _execution_id: executionId,
      _depth: currentDepth,
    };
    const providedMeta = execOptions?.meta;
    let resolvedMeta: ExecutionMeta;
    try {
      if (!providedMeta) {
        resolvedMeta = createExecutionMeta({ systemKeys: rootSystemDefaults });
      } else if (currentDepth === 0) {
        // Root entry — treat any provided meta as external input. Extract
        // its raw snapshot (handles both ExecutionMeta and plain records)
        // and push it through the untrusted-input factory.
        const rawSnapshot = isExecutionMeta(providedMeta)
          ? providedMeta.toJSON()
          : (providedMeta as Record<string, unknown>);
        resolvedMeta = createExecutionMeta({
          raw: rawSnapshot,
          systemKeys: rootSystemDefaults,
        });
      } else {
        // Nested call — provided meta is framework-built via extend.
        // Trust it, only filling system keys that somehow went missing
        // (defensive — expected to be a no-op in practice).
        resolvedMeta = isExecutionMeta(providedMeta)
          ? fillMissingSystemKeys(providedMeta, rootSystemDefaults)
          : createExecutionMeta({
              raw: providedMeta as Record<string, unknown>,
              systemKeys: rootSystemDefaults,
            });
      }
    } catch (err) {
      if (err instanceof MetaSizeError) {
        // Meta resolution itself failed — no `metaSnapshot` is available yet.
        // Record the system-default frame plus the rejected payload size as
        // diagnostic context so audit can reconstruct what was attempted.
        // Mirror the early-failure metric pattern used by exposure / validation
        // paths so monitoring dashboards see meta-size rejections.
        const durationMs = Date.now() - startedAt.getTime();
        metrics.increment("action.executed", {
          action: actionName,
          entity: "",
          status: "failed",
        });
        metrics.timing("action.duration_ms", durationMs, {
          action: actionName,
          entity: "",
        });
        await logExecution({
          id: executionId,
          action: actionName,
          actor,
          input,
          status: "failed",
          error: { message: err.message, code: err.code },
          meta: {
            ...rootSystemDefaults,
            _meta_rejected: { sizeBytes: err.sizeBytes, maxBytes: err.maxBytes },
          },
          startedAt,
        });
        return {
          success: false,
          data: { error: err.message, code: err.code } as T,
          executionId,
        };
      }
      throw err;
    }
    /**
     * Frozen JSON snapshot of the resolved meta. Recorded on every execution
     * log entry per Spec 65 §9. Captured once (not per log call) — meta is
     * immutable after construction, so reusing the snapshot is safe.
     */
    const metaSnapshot = resolvedMeta.toJSON();

    // Step 0: Recursion depth check
    if (currentDepth > MAX_CHILD_DEPTH) {
      await logExecution({
        id: executionId,
        action: actionName,
        actor,
        input,
        status: "failed",
        error: { message: `Maximum child action recursion depth (${MAX_CHILD_DEPTH}) exceeded` },
        meta: metaSnapshot,
        startedAt,
      });
      return {
        success: false,
        data: {
          error: `Maximum child action recursion depth (${MAX_CHILD_DEPTH}) exceeded`,
        } as T,
        executionId,
      };
    }

    // Step 0b: Idempotency check
    // Scope key by action name + tenant to prevent cross-action/cross-tenant collisions.
    // Only apply at top level — child executions (depth > 0) do not inherit idempotency.
    //
    // Spec 65 §5: behavior-affecting meta (e.g. `dry_run`, `skip_notifications`,
    // `bulk`, `default.*`) is folded into the cache key so two requests with
    // the same idempotency key but different behavior-affecting meta are
    // treated as different operations. Observational keys (locale, view, etc.)
    // are intentionally excluded so they don't fragment the cache.
    const rawIdempotencyKey = currentDepth === 0 ? execOptions?.idempotencyKey : undefined;
    const metaHash = rawIdempotencyKey ? hashBehaviorAffectingMeta(metaSnapshot) : "";
    // Percent-encode `:` and `%` in the user-provided rawKey so a caller
    // can't craft `K:m:<hash>` to collide with a separate request whose
    // legitimate hashed suffix would be `:m:<hash>`. Without this, the
    // 32-bit hash is brute-forceable in seconds (security-high; gemini PR
    // review on #227). Encoding is reversible and cheap; pure-alphanumeric
    // keys are unchanged, so existing users see no difference.
    const safeRawKey = rawIdempotencyKey
      ? rawIdempotencyKey.replaceAll("%", "%25").replaceAll(":", "%3A")
      : undefined;
    const baseIdempotencyKey = safeRawKey
      ? `${actionName}:${execOptions?.tenantId ?? ""}:${safeRawKey}`
      : undefined;
    const idempotencyKey = baseIdempotencyKey
      ? metaHash
        ? `${baseIdempotencyKey}:m:${metaHash}`
        : baseIdempotencyKey
      : undefined;
    // Guard the varchar(255) idempotency_key column. PostgreSQL's varchar
    // counts codepoints, so use the spread/iterator codepoint count rather
    // than `.length` (which counts UTF-16 code units and over-counts
    // surrogate-pair emoji). Fail before the handler runs — otherwise
    // persistence fails after the mutation already committed and the
    // caller sees a false negative.
    const idempotencyKeyCodepoints = idempotencyKey ? [...idempotencyKey].length : 0;
    if (idempotencyKey && idempotencyKeyCodepoints > 255) {
      const errMsg = `Idempotency key + meta hash exceeds 255 characters (got ${idempotencyKeyCodepoints}). Shorten the caller-provided idempotency key.`;
      await logExecution({
        id: executionId,
        action: actionName,
        actor,
        input,
        status: "failed",
        error: { message: errMsg, code: "core.action.idempotency_key_too_long" },
        meta: metaSnapshot,
        startedAt,
      });
      return {
        success: false,
        data: { error: errMsg, code: "core.action.idempotency_key_too_long" } as T,
        executionId,
      };
    }
    if (idempotencyKey && executionLogger?.getByIdempotencyKey) {
      let existing = await executionLogger.getByIdempotencyKey(idempotencyKey);
      // Rollout fallback: a meta-suffixed probe miss also looks up the legacy
      // un-suffixed key so entries written before this change are honored
      // during a deployment window. Guard against returning an unrelated
      // legacy entry for a semantically-different retry by comparing the
      // stored entry's behavior-affecting subset hash to the current one —
      // only a match (or a true legacy entry with no recorded meta) wins.
      if (!existing && metaHash && baseIdempotencyKey) {
        const candidate = await executionLogger.getByIdempotencyKey(baseIdempotencyKey);
        if (candidate) {
          const storedMeta = candidate.meta as Record<string, unknown> | undefined;
          const storedHash = hashBehaviorAffectingMeta(storedMeta);
          if (storedHash === metaHash) {
            existing = candidate;
          }
        }
      }
      if (existing && existing.status === "succeeded") {
        return {
          success: true,
          data: existing.output as T,
          executionId: existing.id,
        };
      }
    }

    // Step 1: Look up action
    const action = registry.get(actionName);
    if (!action) {
      await logExecution({
        id: executionId,
        action: actionName,
        actor,
        input,
        status: "failed",
        error: { message: `Action "${actionName}" not found` },
        meta: metaSnapshot,
        startedAt,
      });
      return {
        success: false,
        data: {
          error: `Action "${actionName}" not found`,
          context: {
            action: actionName,
            suggestion: `Check action name spelling or register the action with defineAction({ name: "${actionName}", ... })`,
          },
        } as T,
        executionId,
      };
    }

    // Step 2: Exposure check.
    // Granular flag allows CommandLayer to skip the check it has already handled.
    //
    // Note: `skipPermissionCheck` is a no-op on the executor after #125 — group
    // authorization lives exclusively in cap-permission via the CommandLayer
    // "permission" slot. Actor-type enforcement (Spec 10 §5) is applied in
    // Step 3 below and runs on every execution path (REST, GraphQL, MCP,
    // direct internal execute) so actor-type gating can't be bypassed.
    const skipExposure = execOptions?.skipExposureCheck ?? false;

    // `channel` was hoisted above for early meta resolution — reuse here.
    if (!skipExposure) {
      if (!isExposed(action.exposure, channel)) {
        const errorMsg = `Action "${actionName}" is not exposed for channel "${channel}"`;
        await logExecution({
          id: executionId,
          action: actionName,
          entity: action.entity,
          actor,
          input,
          status: "blocked",
          error: { message: errorMsg },
          meta: metaSnapshot,
          startedAt,
        });
        return {
          success: false,
          data: {
            error: errorMsg,
            context: {
              action: actionName,
              entity: action?.entity,
              constraint: "exposure",
              expected: `Action exposed for channel "${channel}"`,
              actual: `Not exposed for "${channel}"`,
              suggestion: `Add exposure config: defineAction({ ..., exposure: { ${channel}: true } })`,
            },
          } as T,
          executionId,
        };
      }
    }

    // Step 3: Actor-type check — Spec 10 authorization field declared on the
    // action itself. Group enforcement moved to the CommandLayer "permission"
    // slot (cap-permission) in #125, but actor-type filtering must hold on
    // every entry point, including GraphQL and direct executor callers.
    const actorTypeError = checkActorType(action, actor);
    if (actorTypeError) {
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "blocked",
        error: { message: actorTypeError },
        meta: metaSnapshot,
        startedAt,
      });
      return {
        success: false,
        data: { error: actorTypeError } as T,
        executionId,
      };
    }

    // Step 4: Input validation.
    const inputValidation = validateInput(action, input);
    if (!inputValidation.valid) {
      const firstError = inputValidation.errors?.[0];
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "failed",
        error: { message: "Input validation failed" },
        meta: metaSnapshot,
        startedAt,
      });
      return {
        success: false,
        data: {
          error: "Input validation failed",
          details: inputValidation.errors,
          context: {
            action: actionName,
            entity: action?.entity,
            field: firstError?.field,
            constraint: "input_validation",
            expected: firstError?.message,
            suggestion: firstError
              ? `Fix field "${firstError.field}": ${firstError.message}`
              : "Check action input against the defined input schema",
          },
        } as T,
        executionId,
      };
    }

    // Build ActionContext
    const childExecutionIds: string[] = [];
    const pendingEvents: PendingEvent[] = [];
    const noopAi: AIService = {
      configured: false,
      defaultProvider: null,
      providerNames: [],
      complete: () => {
        throw new Error(
          "AI service is not configured. Add an 'ai' section to your LinchKit config.",
        );
      },
    };
    // Build DataQueryOptions for locale and includeDeleted (tenant isolation is now handled by the provider wrapper)
    const queryOptions: DataQueryOptions | undefined =
      execOptions?.locale || execOptions?.includeDeleted
        ? { locale: execOptions?.locale, includeDeleted: execOptions?.includeDeleted }
        : undefined;

    // Wrap the base DataProvider with tenant isolation when tenantId is present.
    // This enforces row-level tenant scoping on ALL data operations (get/query/create/update/delete/count).
    const baseProvider: DataProvider = execOptions?.tenantId
      ? createTenantAwareDataProvider(dataProvider, execOptions.tenantId)
      : dataProvider;

    // Mutable provider reference — reassigned inside transaction callback
    // so that ctx closures automatically use the transactional connection.
    let activeProvider: DataProvider = baseProvider;

    // Hoist transaction-related flags so the Step 4b read path AND the
    // `ctx.execute` closure can detect in-transaction state. Both flags are
    // re-used at the actual transaction site below — this is a single source
    // of truth, not a cached duplicate.
    //
    // `parentTxProvider` is set when this execution was invoked from a
    // parent's `ctx.execute` while the parent was inside an open transaction
    // (Spec 26 §1.1 nested-action transactions). When set, all data ops in
    // this execution participate in the parent's transaction.
    //
    // `useTransaction` is true when the current action opens its own
    // transaction (no parent tx, action.policy.transaction !== false, and
    // a TransactionManager is wired).
    const parentTxProvider = execOptions?._txDataProvider;
    const useTransaction = !!transactionManager && action.policy?.transaction !== false;
    /**
     * True once a database transaction is actually open for this execution
     * (either because the parent passed one in or this execution opened
     * its own). The `ctx.execute` closure forwards this flag to children so
     * they can decide whether to participate in a shared transaction OR
     * open their own — Spec 26 §1.1 only nests transactions when one is
     * actually live. Without this flag the engine would treat any
     * non-null `activeProvider` as "in a transaction" and a
     * `policy.transaction:false` parent would silently swallow the
     * transaction declaration on its child.
     */
    let inTransaction = false;

    // ── Step 4b: Field-lock preflight for declarative updates ──────
    //
    // Lock enforcement fires from two places (Spec 63 Phase 1):
    //
    //   1. Here (declarative-update path). When `action.setFields` or
    //      `action.stateTransition` is declared, the executor writes
    //      directly via `executor`'s Step 7 logic and never passes through
    //      the `ctx.update` wrapper below. We pre-flight those writes here.
    //
    //   2. `ctx.update()` wrapper (handler path). Handler-based actions
    //      compute their writes at runtime; the wrapper catches them at the
    //      moment `ctx.update(entity, id, data)` is called. This covers
    //      handler-computed writes that the caller's input doesn't reveal
    //      (e.g., a handler that rewrites an immutable field with a
    //      constant without the caller passing that field in).
    //
    // Both paths funnel through `checkFieldLocks`; they differ only in when
    // and with what "writes" argument they invoke it. Step 4b owns the
    // existingRecord fetch and reuses it in Step 6 below to avoid a double
    // round-trip on real DBs.
    //
    // Why `resolve()` instead of `get()`:
    //   - Child schemas inherit immutable/lockWhen from their parent.
    //   - Interfaces inject fields with their own lock metadata.
    //   - Tenant overlays (`applyOverride`) can tighten constraints
    //     (e.g., flip a field to `immutable: true`).
    // The raw `EntityDefinition.fields` sees none of the above; without
    // `resolve()` those flows would silently bypass lock enforcement.
    const recordId = input.id as string | undefined;

    // resolve() throws when the entity isn't registered — a missing entity is
    // already surfaced by downstream layers (write will fail), so degrade
    // gracefully here rather than fail-closing on a diagnostic error.
    let resolvedEntity: ReturnType<EntityRegistry["resolve"]> | undefined;
    if (entityRegistry) {
      try {
        resolvedEntity = entityRegistry.resolve(action.entity);
      } catch (err) {
        logger.warn(
          `[field-lock] Cannot resolve entity "${action.entity}" — skipping lock check: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Build a flat FieldDefinition map for the checker. Walking
    // `resolvedEntity.fields` captures inherited + interface + override fields.
    const resolvedFields: Record<string, FieldDefinition> = {};
    if (resolvedEntity) {
      for (const [fname, rf] of Object.entries(resolvedEntity.fields)) {
        resolvedFields[fname] = rf.definition;
      }
    }

    const lockAllWhen = resolvedEntity?.source.lockAllWhen;
    const lockAllowFields = resolvedEntity?.source.lockAllowFields;

    const hasLockMetadata =
      !!resolvedEntity &&
      (lockAllWhen !== undefined ||
        Object.values(resolvedFields).some(
          (f) => f.immutable === true || f.readonly === true || f.lockWhen !== undefined,
        ));
    // Distinguish update-semantics actions from creates. `input.id` alone is
    // NOT a reliable signal — generated `create_<entity>` actions accept a
    // caller-supplied primary key and forward it to `ctx.create(...)`, which
    // would otherwise be misread as an update and blocked with a
    // lock_preflight error before the row exists. Declarative update
    // markers (`setFields` or `stateTransition`) are strong update signals;
    // for handler-based actions the executor can't tell create from update
    // statically, so we only preflight when the fetch actually finds a row.
    const isDeclarativeUpdate =
      (action.setFields !== undefined && Object.keys(action.setFields).length > 0) ||
      action.stateTransition !== undefined;
    // Step 4b's preflight only covers declarative writes. Handler-based
    // actions get their lock check from the `ctx.update` wrapper built
    // below, which inspects the exact write-time data. Running Step 4b for
    // handler actions would (a) flag unused caller-input keys that the
    // handler never persists (P2 gap from round 5) and (b) miss
    // handler-computed writes that aren't in `input` at all (P1 gap).
    const needsDeclarativeLockCheck =
      !!recordId && !!resolvedEntity && hasLockMetadata && isDeclarativeUpdate;
    const needsStateFetch = !!recordId && !!action.stateTransition && !!stateMachine;

    let existingRecord: Record<string, unknown> | undefined;
    let existingRecordFetchError = false;
    if (recordId && (needsDeclarativeLockCheck || needsStateFetch)) {
      // Read through the parent's transactional provider when this is a
      // nested `ctx.execute` inside an open transaction. Otherwise a child
      // action sees the pre-transaction snapshot — a parent that just wrote
      // `status = "submitted"` would have the write invisible to the child,
      // letting `lockWhen: { state: "submitted" }` slip past enforcement.
      // Tenant wrapping matches: the parent's txProvider is already
      // tenant-scoped, so don't re-wrap. `parentTxProvider` is hoisted above.
      const readProvider: DataProvider = parentTxProvider ?? baseProvider;
      try {
        existingRecord = await readProvider.get(action.entity, recordId, queryOptions);
      } catch {
        existingRecordFetchError = true;
      }
    }

    /**
     * Build a failed ActionResult for a field-lock preflight failure. Used
     * by both the declarative-update path (Step 4b) and the handler path
     * (ctx.update wrapper, via Step 7's catch). `entityName` is passed
     * explicitly because TS can't narrow `action` (which is `let`-typed
     * across the broader executeInner scope) across this helper boundary.
     */
    async function buildLockPreflightResult(
      failedRecordId: string,
      entityName: string,
    ): Promise<ActionResult<T>> {
      const errorMsg = `Cannot verify field locks: record "${failedRecordId}" in entity "${entityName}" could not be read`;
      await logExecution({
        id: executionId,
        action: actionName,
        entity: entityName,
        actor,
        input,
        status: "blocked",
        error: { message: errorMsg, code: "validation.field.locked" },
        meta: metaSnapshot,
        startedAt,
      });
      // Metrics parity with Step 7's catch: declarative-path lock rejects
      // must register in the same counters as handler-path ones.
      const durationMs = Date.now() - startedAt.getTime();
      metrics.increment("action.executed", {
        action: actionName,
        entity: entityName,
        status: "failed",
      });
      metrics.timing("action.duration_ms", durationMs, {
        action: actionName,
        entity: entityName,
      });
      return {
        success: false,
        data: {
          error: errorMsg,
          code: "validation.field.locked",
          context: {
            action: actionName,
            entity: entityName,
            constraint: "lock_preflight",
            suggestion:
              "The target record could not be read before applying field-lock checks — ensure the record exists and is accessible.",
          },
        } as T,
        executionId,
      };
    }

    /**
     * Build a failed ActionResult for a field-lock violation. Used by both
     * the declarative path (Step 4b) and the handler path (ctx.update
     * wrapper, via Step 7's catch). Keeps the shape identical so
     * downstream consumers (CommandLayer, client error renderers) don't
     * care which path raised the violation.
     */
    async function buildLockViolationResult(
      violations: readonly FieldLockViolation[],
      entityName: string,
    ): Promise<ActionResult<T>> {
      if (violations.length === 0) {
        // Defensive: contract says non-empty.
        throw new Error("Unreachable: buildLockViolationResult called with empty violations");
      }
      // Order-independent classification: when a request mutates BOTH an
      // immutable field and a state-locked field, the top-level error code
      // must not depend on caller input key order. Immutable is the more
      // specific (permanent) rule, so it wins when present. The first
      // immutable violation also determines the error context's `field`
      // and `suggestion`. `details[]` keeps every violation in input order
      // so clients can render per-field UI.
      const immutableViolation = violations.find((v) => v.type === "immutable");
      const primary = immutableViolation ?? (violations[0] as FieldLockViolation);
      const isImmutable = primary.type === "immutable";
      const errorCode = isImmutable ? "validation.field.immutable" : "validation.field.locked";
      const errorMsg = "Cannot modify locked fields";
      await logExecution({
        id: executionId,
        action: actionName,
        entity: entityName,
        actor,
        input,
        status: "blocked",
        error: { message: errorMsg, code: errorCode },
        meta: metaSnapshot,
        startedAt,
      });
      // Metrics parity with Step 7's catch: declarative-path lock rejects
      // must register in the same counters as handler-path ones.
      const durationMs = Date.now() - startedAt.getTime();
      metrics.increment("action.executed", {
        action: actionName,
        entity: entityName,
        status: "failed",
      });
      metrics.timing("action.duration_ms", durationMs, {
        action: actionName,
        entity: entityName,
      });
      return {
        success: false,
        data: {
          error: errorMsg,
          code: errorCode,
          details: violations.map((v) => ({
            field: v.field,
            type: v.type,
            message: v.message,
          })),
          context: {
            action: actionName,
            entity: entityName,
            field: primary.field,
            constraint: isImmutable ? "immutable" : "locked",
            suggestion: isImmutable
              ? `Field "${primary.field}" cannot be changed after it is first set`
              : `Field "${primary.field}" is locked in the current state and cannot be modified`,
          },
        } as T,
        executionId,
      };
    }

    // The declarative-update lock check (formerly Step 4b) was relocated
    // INTO runHandler below. CodeRabbit PR #203 review: a Step 4b preflight
    // reads from `baseProvider`, but Step 7 then opens a new transaction and
    // writes via the txProvider — a concurrent transaction could mutate the
    // row between the preflight and the write, bypassing enforcement. The
    // authoritative declarative lock check now runs inside runHandler against
    // the same `dp` reference the write uses (txProvider when transactional,
    // baseProvider otherwise), so check and write share one snapshot. Step 4b
    // retains only the existing-record fetch needed for Step 6 state
    // transition gating.

    // Meta was resolved at the top of `execute(...)` so every early-failure
    // log entry (depth check, action lookup, exposure, validation) records
    // the meta snapshot. `resolvedMeta` and `metaSnapshot` are in scope here.

    const ctx: ActionContext = {
      input,
      actor,
      tenantId: execOptions?.tenantId,
      logger,
      signal: undefined,
      ai: aiService ?? noopAi,
      config: configRegistry ?? ConfigRegistry.empty(),
      executionId,
      timestamp: startedAt,
      meta: resolvedMeta,
      get: (entity, id) => activeProvider.get(entity, id, queryOptions),
      query: (entity, filter) => activeProvider.query(entity, filter, queryOptions),
      // ctx.create skips lock enforcement: creates are by definition writing
      // a new row, immutable only applies to existing non-null values, and
      // lockWhen/lockAllWhen require a pre-existing record to evaluate.
      create: (entity, data) => activeProvider.create(entity, data),
      update: async (entity, id, data) => {
        // Handler-path lock check (Spec 63 round-5/6). Resolves the target
        // entity each time so handlers updating a related record (cross-
        // entity write) get the target entity's own immutable / lockWhen /
        // lockAllWhen rules — not the current action's. Skips silently when
        // the entity isn't registered or has no lock metadata.
        if (entityRegistry) {
          let targetResolved: ReturnType<EntityRegistry["resolve"]> | undefined;
          try {
            targetResolved = entityRegistry.resolve(entity);
          } catch {
            targetResolved = undefined;
          }
          if (targetResolved) {
            const targetFields: Record<string, FieldDefinition> = {};
            for (const [fname, rf] of Object.entries(targetResolved.fields)) {
              targetFields[fname] = rf.definition;
            }
            const targetLockAllWhen = targetResolved.source.lockAllWhen;
            const targetLockAllowFields = targetResolved.source.lockAllowFields;
            const targetHasLockMetadata =
              targetLockAllWhen !== undefined ||
              Object.values(targetFields).some(
                (f) => f.immutable === true || f.readonly === true || f.lockWhen !== undefined,
              );
            if (targetHasLockMetadata) {
              // Fetch at write-time (not reusing any earlier snapshot) — the
              // handler may have done other writes that changed this row.
              let current: Record<string, unknown>;
              try {
                current = await activeProvider.get(entity, id, queryOptions);
              } catch {
                // Fail closed when the row can't be read — same stance as
                // the declarative preflight's fetch-error path.
                throw new LockPreflightError(entity, id);
              }
              const writesToCheck: Record<string, unknown> = { ...data };
              delete writesToCheck.id;
              const violations = checkFieldLocks({
                fields: targetFields,
                lockAllWhen: targetLockAllWhen,
                lockAllowFields: targetLockAllowFields,
                existingRecord: current,
                input: writesToCheck,
              });
              if (violations.length > 0) {
                throw new LockViolationError(violations, entity);
              }
            }
          }
        }
        return activeProvider.update(entity, id, data, queryOptions);
      },
      // ctx.delete skips lock enforcement: Spec 63 regulates field writes,
      // not row deletion. Delete authorization lives elsewhere (soft-delete
      // rules, permission slot).
      delete: (entity, id) => activeProvider.delete(entity, id, queryOptions),
      execute: async (childActionName, childInput, childOpts) => {
        // Extend parent meta for the child call: parent keys always win (§4.3),
        // framework updates _depth and _source_action unconditionally (§4.4),
        // and the root _execution_id is preserved across the chain.
        // Using the standalone extendExecutionMeta helper keeps the public
        // ExecutionMeta interface read-only from the handler's perspective —
        // handlers can't accidentally mutate meta by calling `.extend(...)`
        // on `ctx.meta`.
        // `extend` enforces the same filter + size limit as root meta
        // construction. If the merged child payload exceeds 8 KB, surface the
        // error as a failed ActionResult rather than letting the exception
        // bubble up and crash the parent handler — consistent with how other
        // child failures flow back to the caller (ctx.execute returns result.data).
        let childMeta: ExecutionMeta;
        try {
          childMeta = extendExecutionMeta(resolvedMeta, childOpts?.meta ?? {}, {
            _depth: currentDepth + 1,
            _source_action: actionName,
          });
        } catch (err) {
          if (err instanceof MetaSizeError) {
            // The child never ran — no execution log entry exists for this
            // rejection. Do NOT push a fake id onto childExecutionIds: that
            // would break `ExecutionLogger.getById()` lookups from the parent
            // log, since no record is ever written under it.
            return { error: err.message, code: err.code };
          }
          throw err;
        }
        // Strip top-level idempotency key from the child invocation. The root
        // ActionExecutor already gates on `currentDepth === 0`, so the key
        // is unused at depth > 0 — but spreading `...execOptions` carried it
        // through anyway and obscured the contract. Spec 26 §1.1 nested
        // transactions: child operations participate in the parent's tx and
        // do NOT register an independent idempotency record.
        const { idempotencyKey: _drop, ...childExecOptions } = execOptions ?? {};
        // Spec 26 §1.1: only forward `_txDataProvider` when the current
        // execution is actually inside an open database transaction. A
        // parent with `policy.transaction:false` does NOT have a tx to share,
        // so its child must be free to open its own (per the child's own
        // `policy.transaction`) instead of riding `baseProvider` mistakenly
        // typed as a "tx provider". Likewise `_parentPendingEvents` is only
        // meaningful when there's a parent tx whose commit will flush them.
        const childTxDataProvider = inTransaction ? activeProvider : undefined;
        const childParentPendingEvents = inTransaction ? pendingEvents : undefined;
        const childResult = await execute(childActionName, childInput, actor, {
          ...childExecOptions,
          _depth: currentDepth + 1,
          _txDataProvider: childTxDataProvider,
          _parentPendingEvents: childParentPendingEvents,
          meta: childMeta,
        });
        childExecutionIds.push(childResult.executionId);
        // Spec 26 §1.1 (nested transactions): when the parent is running
        // inside a database transaction and the child returns a failed
        // result, the parent's transaction is now on a rollback path —
        // most engines (Postgres included) reject further writes after a
        // statement error inside an open transaction. If the parent
        // handler swallows the failed `data` and tries to keep going, the
        // very next write will surface a "current transaction is aborted"
        // style error. Log a warning so the swallowing path is at least
        // visible in logs (Spec requirement: child invocation must warn
        // when the parent appears to be ignoring a child failure inside a
        // shared transaction). `Logger.warn` (not `console.warn`) so the
        // message routes through the runtime logger configured by the host.
        if (!childResult.success && inTransaction) {
          logger.warn(
            `[nested-action] Child action "${childActionName}" failed inside parent transaction "${actionName}" (executionId=${executionId}). The parent's transaction is now on a rollback path — any subsequent ctx.create/update/delete will fail. Re-throw the error from your handler, or return early without further writes.`,
          );
        }
        return childResult.data;
      },
      hasCapability: (name: string) => capabilityNames.has(name),
      emit: (eventType, payload) => {
        const trace = getCurrentTrace();
        pendingEvents.push({
          type: eventType,
          payload,
          tenantId: execOptions?.tenantId,
          sourceAction: actionName,
          sourceExecutionId: executionId,
          traceId: trace?.traceId,
          // Capture this action's ExecutionMeta so the eventual handler
          // sees the originating action's caller hints (Spec 65 §7).
          meta: resolvedMeta,
        });
      },
    };

    // Step 5: Pre-validation
    const preValidation = runPreValidation(action, ctx);
    if (!preValidation.valid) {
      const firstError = preValidation.errors?.[0];
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "failed",
        error: { message: "Validation failed" },
        meta: metaSnapshot,
        startedAt,
      });
      return {
        success: false,
        data: {
          error: "Validation failed",
          details: preValidation.errors,
          context: {
            action: actionName,
            entity: action?.entity,
            constraint: "pre_validation",
            field: firstError?.field,
            expected: firstError?.message,
            suggestion: firstError
              ? `Fix field "${firstError.field}": ${firstError.message}`
              : "Check input values against action validation rules",
          },
        } as T,
        executionId,
      };
    }

    // Step 6: State transition check
    let stateTransitionRecord: { from: string; to: string } | undefined;

    if (action.stateTransition && stateMachine) {
      const fromStates = Array.isArray(action.stateTransition.from)
        ? action.stateTransition.from
        : [action.stateTransition.from];

      // Get current state from input or record. The record itself was already
      // fetched above (Step 4b) when `input.id` was present; reuse it to
      // avoid a second round-trip on real databases.
      let currentState: string | undefined;

      if (recordId) {
        if (existingRecordFetchError || !existingRecord) {
          // Record fetch failed — fail closed when state transition is required
          const errorMsg = `Cannot verify state transition: record "${recordId}" not found in entity "${action.entity}"`;
          await logExecution({
            id: executionId,
            action: actionName,
            entity: action?.entity,
            actor,
            input,
            status: "failed",
            error: { message: errorMsg },
            meta: metaSnapshot,
            startedAt,
          });
          return {
            success: false,
            data: { error: errorMsg } as T,
            executionId,
          };
        }
        currentState = existingRecord.status as string | undefined;
      }

      if (currentState !== undefined) {
        // Check if current state is in the allowed "from" states
        if (!fromStates.includes(currentState)) {
          const errorMsg = `State transition not allowed: current state "${currentState}" is not in allowed states [${fromStates.join(", ")}]`;
          await logExecution({
            id: executionId,
            action: actionName,
            entity: action?.entity,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            meta: metaSnapshot,
            startedAt,
          });
          return {
            success: false,
            data: {
              error: errorMsg,
              context: {
                entity: action?.entity,
                action: actionName,
                field: "status",
                constraint: "state_transition",
                expected: `Current state in [${fromStates.join(", ")}]`,
                actual: `Current state is "${currentState}"`,
                suggestion: `Record is in "${currentState}" state. Allowed source states for "${actionName}" are: [${fromStates.join(", ")}]`,
              },
            } as T,
            executionId,
          };
        }

        // Also validate against state machine if available
        if (!canTransition(stateMachine, currentState, actionName)) {
          const available = getAvailableActions(stateMachine, currentState);
          const errorMsg = `State machine does not allow action "${actionName}" from state "${currentState}"`;
          await logExecution({
            id: executionId,
            action: actionName,
            entity: action?.entity,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            meta: metaSnapshot,
            startedAt,
          });
          return {
            success: false,
            data: {
              error: errorMsg,
              context: {
                entity: action?.entity,
                action: actionName,
                field: "status",
                constraint: "state_machine",
                expected: `Action "${actionName}" allowed from current state`,
                actual: `State "${currentState}" does not permit "${actionName}"`,
                suggestion:
                  available.length > 0
                    ? `Available actions from "${currentState}": [${available.join(", ")}]`
                    : `No actions available from state "${currentState}"`,
              },
            } as T,
            executionId,
          };
        }

        stateTransitionRecord = { from: currentState, to: action.stateTransition.to };
      }
    }

    // Step 7: Execute
    //
    // When a TransactionManager is provided, the handler runs within a
    // database transaction. Events collected via ctx.emit() are persisted
    // to _linchkit.events in the same transaction (Transactional Outbox).
    // On failure, both data changes and events roll back atomically.
    try {
      let resultData: unknown;
      let record: Record<string, unknown> | undefined;

      /** Run the action handler or declarative logic against a given DataProvider */
      const runHandler = async (dp: DataProvider): Promise<void> => {
        activeProvider = dp;
        if (action.handler) {
          resultData = await action.handler(ctx);
        } else {
          // Declarative action — no handler needed
          const recordIdLocal = input.id as string | undefined;

          if (recordIdLocal) {
            const updates: Record<string, unknown> = {};

            if (action.setFields) {
              for (const [key, value] of Object.entries(action.setFields)) {
                updates[key] = resolveFieldExpression(value, input, actor);
              }
            }

            if (action.stateTransition) {
              updates.status = action.stateTransition.to;
            }

            if (Object.keys(updates).length > 0) {
              // Field-lock check INSIDE the transaction so the read snapshot
              // matches the write snapshot. CodeRabbit PR #203: doing this at
              // the pre-pipeline preflight (formerly Step 4b) opens a TOCTOU
              // gap when transactionManager is in play — a concurrent tx
              // could change lock-critical fields between the preflight read
              // and the write inside the new tx. Reading via `dp` here uses
              // the txProvider when transactional, baseProvider otherwise,
              // matching what the write itself sees.
              if (resolvedEntity && hasLockMetadata && action) {
                let txCurrent: Record<string, unknown>;
                try {
                  txCurrent = await dp.get(action.entity, recordIdLocal, queryOptions);
                } catch {
                  throw new LockPreflightError(action.entity, recordIdLocal);
                }
                const writesToCheck: Record<string, unknown> = { ...updates };
                delete writesToCheck.id;
                const violations = checkFieldLocks({
                  fields: resolvedFields,
                  lockAllWhen,
                  lockAllowFields,
                  existingRecord: txCurrent,
                  input: writesToCheck,
                });
                if (violations.length > 0) {
                  throw new LockViolationError(violations, action.entity);
                }
              }

              record = await dp.update(action.entity, recordIdLocal, updates, queryOptions);
              resultData = record;
            }
          }
        }
      };

      // `parentTxProvider` and `useTransaction` are hoisted near the top of
      // `execute(...)` so the `ctx.execute` closure can detect in-transaction
      // state when warning about nested-action failure swallowing.
      const parentEvents = execOptions?._parentPendingEvents;

      if (parentTxProvider) {
        // Shared transaction path: parent already opened a transaction.
        // Use the parent's transactional provider directly so all data
        // operations participate in the same DB transaction.
        // Note: parent already wraps with tenant isolation, so no double-wrap needed.
        inTransaction = true;
        await runHandler(parentTxProvider);
        // Propagate child events to parent's pending list so they are
        // persisted atomically when the parent's transaction commits.
        if (parentEvents) {
          parentEvents.push(...pendingEvents);
        }
      } else if (useTransaction) {
        inTransaction = true;
        await transactionManager.runInTransaction((txProvider) => {
          // Wrap the transactional provider with tenant isolation
          const scopedTxProvider = execOptions?.tenantId
            ? createTenantAwareDataProvider(txProvider, execOptions.tenantId)
            : txProvider;
          return runHandler(scopedTxProvider);
        }, pendingEvents);
      } else {
        // No transaction in play — `inTransaction` stays false so any
        // nested ctx.execute that happens inside this handler can open
        // its own transaction per its own `policy.transaction`.
        await runHandler(baseProvider);
      }

      const durationMs = Date.now() - startedAt.getTime();
      metrics.increment("action.executed", {
        action: actionName,
        entity: action.entity ?? "",
        status: "succeeded",
      });
      metrics.timing("action.duration_ms", durationMs, {
        action: actionName,
        entity: action.entity ?? "",
      });

      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        output: resultData,
        status: "succeeded",
        stateTransition: stateTransitionRecord,
        childExecutionIds: childExecutionIds.length > 0 ? childExecutionIds : undefined,
        idempotencyKey,
        meta: metaSnapshot,
        startedAt,
      });

      // Emit action.succeeded event to EventBus (non-blocking — must not affect action result)
      if (eventBus) {
        try {
          await eventBus.emit({
            id: crypto.randomUUID(),
            type: "action.succeeded",
            category: "runtime",
            timestamp: new Date(),
            actor: { type: actor.type, id: actor.id },
            entity: action?.entity,
            action: actionName,
            executionId,
            tenantId: execOptions?.tenantId,
            payload: {
              action: actionName,
              ...(typeof resultData === "object" && resultData !== null
                ? (resultData as Record<string, unknown>)
                : { result: resultData }),
            },
            meta: resolvedMeta,
          });
        } catch {
          // Don't fail the action if event emission fails
        }

        // Flush pending events (from ctx.emit()) to in-memory EventBus subscribers.
        // Only flush at the root action level — child actions sharing a parent transaction
        // have their events merged into the parent's pendingEvents and will be flushed
        // when the parent's transaction commits.
        if (!execOptions?._txDataProvider && pendingEvents.length > 0) {
          for (const pe of pendingEvents) {
            try {
              await eventBus.emit({
                id: crypto.randomUUID(),
                type: pe.type,
                category: pe.type.startsWith("record.") ? "change" : "custom",
                timestamp: new Date(),
                actor: { type: actor.type, id: actor.id },
                entity: typeof pe.payload.entity === "string" ? pe.payload.entity : undefined,
                recordId: typeof pe.payload.recordId === "string" ? pe.payload.recordId : undefined,
                tenantId: pe.tenantId,
                executionId: pe.sourceExecutionId ?? executionId,
                payload: pe.payload,
                // Use the originating action's meta when present; fall back
                // to the flushing action's meta for legacy entries that
                // predate the meta field.
                meta: pe.meta ?? resolvedMeta,
              });
            } catch {
              // Non-blocking — don't fail the action if flush fails
            }
          }
        }
      }

      return {
        success: true,
        data: resultData as T,
        record,
        executionId,
      };
    } catch (err) {
      // Field-lock violations raised from the ctx.update wrapper surface as
      // these dedicated errors. Convert them to the standard failed
      // ActionResult shape Step 4b produces so both the declarative and
      // handler paths emit identical results to downstream consumers.
      //
      // Metrics: these are authorization-style blocks, not execution
      // failures, but we still route them through the failed counter so
      // operators can monitor lock-block rates. A future split could add a
      // dedicated `blocked` status if the signal is worth separating. The
      // metric emit happens INSIDE the helpers so declarative-path
      // rejections (which return through the helpers without entering this
      // catch) get counted identically.
      if (err instanceof LockViolationError) {
        return buildLockViolationResult(err.violations, err.entity);
      }
      if (err instanceof LockPreflightError) {
        return buildLockPreflightResult(err.recordId, err.entity);
      }

      const durationMs = Date.now() - startedAt.getTime();
      metrics.increment("action.executed", {
        action: actionName,
        entity: action.entity ?? "",
        status: "failed",
      });
      metrics.timing("action.duration_ms", durationMs, {
        action: actionName,
        entity: action.entity ?? "",
      });

      // On failure, pendingEvents were NOT persisted (transaction rolled back)
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        stateTransition: stateTransitionRecord,
        childExecutionIds: childExecutionIds.length > 0 ? childExecutionIds : undefined,
        meta: metaSnapshot,
        startedAt,
      });

      // Emit action.failed event to EventBus (non-blocking — must not affect action result)
      if (eventBus) {
        try {
          await eventBus.emit({
            id: crypto.randomUUID(),
            type: "action.failed",
            category: "runtime",
            timestamp: new Date(),
            actor: { type: actor.type, id: actor.id },
            entity: action?.entity,
            action: actionName,
            executionId,
            tenantId: execOptions?.tenantId,
            payload: {
              action: actionName,
              error: err instanceof Error ? err.message : String(err),
            },
            meta: resolvedMeta,
          });
        } catch {
          // Don't fail the action if event emission fails
        }
      }

      return {
        success: false,
        data: {
          error: err instanceof Error ? err.message : String(err),
        } as T,
        executionId,
      };
    }
  }

  return {
    registry,
    execute,
  };
}
