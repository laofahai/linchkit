/**
 * Action Engine
 *
 * Manages action registration and execution.
 * Actions are the sole write entry point of the system.
 * Execution follows the unified execution contract (see spec 39).
 */

import { ConfigRegistry } from "../config/config-registry";
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
import { createExecutionMeta, extendExecutionMeta, MetaSizeError } from "../types/execution-meta";
import type { Logger } from "../types/logger";
import { checkFieldLocks, type FieldLockViolation } from "./field-lock-checker";
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

  /** Helper: build and log an execution entry */
  async function logExecution(
    entry: Omit<ExecutionLogEntry, "completedAt" | "duration"> & { startedAt: Date },
  ): Promise<void> {
    if (!executionLogger) return;
    const completedAt = new Date();
    const duration = completedAt.getTime() - entry.startedAt.getTime();
    await executionLogger.log({ ...entry, completedAt, duration } as ExecutionLogEntry);
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

    // Step 0: Recursion depth check
    const currentDepth = execOptions?._depth ?? 0;
    if (currentDepth > MAX_CHILD_DEPTH) {
      await logExecution({
        id: executionId,
        action: actionName,
        actor,
        input,
        status: "failed",
        error: { message: `Maximum child action recursion depth (${MAX_CHILD_DEPTH}) exceeded` },
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
    // TODO(spec-65 Phase 2): If an action's `ctx.meta` participates in
    // decision-making (e.g., `dry_run`, `skip_notifications`), a second
    // request reusing the same `idempotencyKey` with different meta will
    // receive the first execution's cached output without re-running. Either
    // hash the normalized meta into the key or reject changed meta for an
    // existing key. Deferred here because it requires a product decision on
    // idempotency semantics (observational meta vs behavior-affecting meta).
    const rawIdempotencyKey = currentDepth === 0 ? execOptions?.idempotencyKey : undefined;
    const idempotencyKey = rawIdempotencyKey
      ? `${actionName}:${execOptions?.tenantId ?? ""}:${rawIdempotencyKey}`
      : undefined;
    if (idempotencyKey && executionLogger?.getByIdempotencyKey) {
      const existing = await executionLogger.getByIdempotencyKey(idempotencyKey);
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

    // Exposure check — default channel to "internal" so the check always runs
    const channel: ExecutionChannel = execOptions?.channel ?? "internal";
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
          startedAt,
        });
        return {
          success: false,
          data: {
            error: errorMsg,
            context: {
              action: actionName,
              entity: action.entity,
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
        startedAt,
      });
      return {
        success: false,
        data: {
          error: "Input validation failed",
          details: inputValidation.errors,
          context: {
            action: actionName,
            entity: action.entity,
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

    // ── Step 4b: Field-lock check (Spec 63 Phase 1) ────────────────
    //
    // The checker needs the existing record, so we hoist the fetch here and
    // reuse it below in Step 6 (state transition) to avoid double-fetch on
    // real DBs. The fetch only runs when:
    //   1. `input.id` is present (update-style call), AND
    //   2. an entityRegistry was injected AND the resolved entity has
    //      something to enforce (immutable / lockWhen / lockAllWhen on any
    //      field, including inherited / interface-injected / overridden
    //      fields), OR the action declares a state transition.
    //
    // When only state-transition needs the record we still fetch so Step 6
    // can consume it without a second round-trip.
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
    const needsLockCheck = !!recordId && !!resolvedEntity && hasLockMetadata;
    const needsStateFetch = !!recordId && !!action.stateTransition && !!stateMachine;

    let existingRecord: Record<string, unknown> | undefined;
    let existingRecordFetchError = false;
    if (recordId && (needsLockCheck || needsStateFetch)) {
      // Read through the parent's transactional provider when this is a
      // nested `ctx.execute` inside an open transaction. Otherwise a child
      // action sees the pre-transaction snapshot — a parent that just wrote
      // `status = "submitted"` would have the write invisible to the child,
      // letting `lockWhen: { state: "submitted" }` slip past enforcement.
      // Tenant wrapping matches: the parent's txProvider is already
      // tenant-scoped, so don't re-wrap.
      const parentTxProvider = execOptions?._txDataProvider;
      const readProvider: DataProvider = parentTxProvider ?? baseProvider;
      try {
        existingRecord = await readProvider.get(action.entity, recordId, queryOptions);
      } catch {
        existingRecordFetchError = true;
      }
    }

    // Fail-closed on lock check — but only when we're sure the action is an
    // update. For declarative-update actions (setFields / stateTransition)
    // the record MUST exist; a failed fetch is a real problem. For handler-
    // based actions without those markers the action may be a create
    // supplying its own primary key — failing closed there would break
    // import/sync flows. The declarative update branch (state transition)
    // has its own fail-closed below for its not-found path.
    if (needsLockCheck && existingRecordFetchError && isDeclarativeUpdate) {
      const errorMsg = `Cannot verify field locks: record "${recordId}" in entity "${action.entity}" could not be read`;
      await logExecution({
        id: executionId,
        action: actionName,
        entity: action.entity,
        actor,
        input,
        status: "blocked",
        error: { message: errorMsg, code: "validation.field.locked" },
        startedAt,
      });
      return {
        success: false,
        data: {
          error: errorMsg,
          code: "validation.field.locked",
          context: {
            action: actionName,
            entity: action.entity,
            constraint: "lock_preflight",
            suggestion:
              "The target record could not be read before applying field-lock checks — ensure the record exists and is accessible.",
          },
        } as T,
        executionId,
      };
    }

    if (needsLockCheck && resolvedEntity && existingRecord) {
      // Pre-compute the effective write set for lock checking.
      //
      //   input (caller-provided)
      //   + setFields resolved values (declarative writes — $-expressions
      //     resolved to concrete values)
      //   - id                        — never lock-checked (key field)
      //   - status (when a state transition is active)
      //
      // The state-transition status write is authorized separately by the
      // state-machine layer. Lock-checking it here would reject valid
      // transitions out of any "locked" state (e.g., transitioning from
      // `draft` when `lockAllWhen: { state: "draft" }` is declared).
      //
      // Handler-based actions (`action.handler`) write via `ctx.update(...)`
      // with arbitrary data that can't be inspected pre-flight. Those writes
      // are NOT lock-checked — see the checker's JSDoc.
      const writesToCheck: Record<string, unknown> = { ...input };
      delete writesToCheck.id;
      if (action.setFields) {
        for (const [key, value] of Object.entries(action.setFields)) {
          writesToCheck[key] = resolveFieldExpression(value, input, actor);
        }
      }
      if (action.stateTransition) {
        delete writesToCheck.status;
      }

      const violations: FieldLockViolation[] = checkFieldLocks({
        fields: resolvedFields,
        lockAllWhen,
        lockAllowFields,
        existingRecord,
        input: writesToCheck,
      });
      if (violations.length > 0) {
        const firstViolation = violations[0];
        if (!firstViolation) {
          // Defensive: violations.length > 0 so firstViolation is always defined,
          // but TS narrows via length check which it doesn't do here.
          throw new Error("Unreachable: violations non-empty but first is undefined");
        }
        const isImmutable = firstViolation.type === "immutable";
        const errorCode = isImmutable ? "validation.field.immutable" : "validation.field.locked";
        const errorMsg = "Cannot modify locked fields";
        await logExecution({
          id: executionId,
          action: actionName,
          entity: action.entity,
          actor,
          input,
          status: "blocked",
          error: { message: errorMsg, code: errorCode },
          startedAt,
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
              entity: action.entity,
              field: firstViolation.field,
              constraint: isImmutable ? "immutable" : "locked",
              suggestion: isImmutable
                ? `Field "${firstViolation.field}" cannot be changed after it is first set`
                : `Field "${firstViolation.field}" is locked in the current state and cannot be modified`,
            },
          } as T,
          executionId,
        };
      }
    }

    // Resolve execution meta. `execOptions.meta` is typed as
    // `ExecutionMeta | Record<string, unknown>` so direct-executor callers can
    // pass a plain record (e.g., `executor.execute(..., { meta: { foo: 1 } })`)
    // without constructing an ExecutionMeta themselves — the natural call
    // shape. Internally we always normalize to an ExecutionMeta before
    // exposing on ctx.meta.
    //
    // `_execution_id` is the ROOT execution record id (Spec 65 §4.4 — keyed
    // against ExecutionLogger.getById), NOT a tracing id. ActionEngine owns
    // its assignment.
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
    const rootSystemDefaults: Record<string, unknown> = {
      _channel: channel,
      _execution_id: executionId,
      _depth: currentDepth,
    };
    const providedMeta = execOptions?.meta;
    // Meta construction can throw MetaSizeError (plain-record wrap + size
    // enforcement, or an already-oversized ExecutionMeta reaching the limit
    // after system keys are added). Direct-executor callers bypass the
    // CommandLayer's catch, so without handling here the exception would
    // escape as unhandled. Return a normal failed ActionResult and log it
    // so callers see the same shape regardless of entry point.
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
        await logExecution({
          id: executionId,
          action: actionName,
          entity: action.entity,
          actor,
          input,
          status: "failed",
          error: { message: err.message, code: err.code },
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
      create: (entity, data) => activeProvider.create(entity, data),
      update: (entity, id, data) => activeProvider.update(entity, id, data, queryOptions),
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
        const childResult = await execute(childActionName, childInput, actor, {
          ...execOptions,
          _depth: currentDepth + 1,
          _txDataProvider: activeProvider,
          _parentPendingEvents: pendingEvents,
          meta: childMeta,
        });
        childExecutionIds.push(childResult.executionId);
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
        startedAt,
      });
      return {
        success: false,
        data: {
          error: "Validation failed",
          details: preValidation.errors,
          context: {
            action: actionName,
            entity: action.entity,
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
            entity: action.entity,
            actor,
            input,
            status: "failed",
            error: { message: errorMsg },
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
            entity: action.entity,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: {
              error: errorMsg,
              context: {
                entity: action.entity,
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
            entity: action.entity,
            actor,
            input,
            status: "blocked",
            error: { message: errorMsg },
            startedAt,
          });
          return {
            success: false,
            data: {
              error: errorMsg,
              context: {
                entity: action.entity,
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
    // to _linchkit_events in the same transaction (Transactional Outbox).
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
          const recordId = input.id as string | undefined;

          if (recordId) {
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
              record = await dp.update(action.entity, recordId, updates, queryOptions);
              resultData = record;
            }
          }
        }
      };

      // Use transaction when available and not explicitly disabled
      const useTransaction = transactionManager && action.policy?.transaction !== false;
      const parentTxProvider = execOptions?._txDataProvider;
      const parentEvents = execOptions?._parentPendingEvents;

      if (parentTxProvider) {
        // Shared transaction path: parent already opened a transaction.
        // Use the parent's transactional provider directly so all data
        // operations participate in the same DB transaction.
        // Note: parent already wraps with tenant isolation, so no double-wrap needed.
        await runHandler(parentTxProvider);
        // Propagate child events to parent's pending list so they are
        // persisted atomically when the parent's transaction commits.
        if (parentEvents) {
          parentEvents.push(...pendingEvents);
        }
      } else if (useTransaction) {
        await transactionManager.runInTransaction((txProvider) => {
          // Wrap the transactional provider with tenant isolation
          const scopedTxProvider = execOptions?.tenantId
            ? createTenantAwareDataProvider(txProvider, execOptions.tenantId)
            : txProvider;
          return runHandler(scopedTxProvider);
        }, pendingEvents);
      } else {
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
            entity: action.entity,
            action: actionName,
            executionId,
            tenantId: execOptions?.tenantId,
            payload: {
              action: actionName,
              ...(typeof resultData === "object" && resultData !== null
                ? (resultData as Record<string, unknown>)
                : { result: resultData }),
            },
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
            entity: action.entity,
            action: actionName,
            executionId,
            tenantId: execOptions?.tenantId,
            payload: {
              action: actionName,
              error: err instanceof Error ? err.message : String(err),
            },
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
