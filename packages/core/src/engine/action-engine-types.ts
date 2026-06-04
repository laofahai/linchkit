/**
 * Action Engine — public type surface.
 *
 * The contract types consumers annotate against (DataProvider, ActionExecutor,
 * ExecuteOptions, …) extracted from action-engine.ts so they can be imported
 * without pulling the executor implementation. action-engine.ts re-exports
 * every name here for backward compatibility, so existing
 * `from "./action-engine"` imports keep working.
 */

import type { ConfigRegistry } from "../config/config-registry";
import type { EntityRegistry } from "../entity/entity-registry";
import type { EventBus } from "../event/event-bus";
import type { MetricsCollector } from "../observability/metrics";
import type { ActionResult, Actor } from "../types/action";
import type { AIService } from "../types/ai";
import type { ApprovalPendingResult } from "../types/approval";
import type { ExecutionLogger } from "../types/execution-log";
import type { ExecutionMeta } from "../types/execution-meta";
import type { Logger } from "../types/logger";
import type {
  ExecuteActionEffect,
  RequireApprovalEffect,
  RuleDefinition,
  TriggerFlowEffect,
} from "../types/rule";
import type { ActionRegistry } from "./action-registry";
import type { InterceptorRegistry } from "./interceptors";
import type { StateMachine } from "./state-machine";

// ── DataProvider interface ──────────────────────────────────

/** Options for data queries — tenant isolation, soft-delete control, and locale */
export interface DataQueryOptions {
  tenantId?: string;
  includeDeleted?: boolean;
  /** Locale for resolving translatable fields (e.g., "zh-CN", "en") */
  locale?: string;
  /**
   * Acquire a row-level write lock (`SELECT … FOR UPDATE`) on the matched row.
   *
   * Only meaningful when the read runs inside a transaction: it pins the row
   * from read to commit, closing the read→write TOCTOU window left open by a
   * plain `SELECT` under READ COMMITTED (see #470). Used by the in-transaction
   * record-state guard re-check (#466/#469). Outside a transaction the lock is
   * acquired and released at statement end, so it has no lasting effect.
   *
   * No-op for stores without row-level locking — the InMemoryStore is
   * single-threaded and already serialized, so it ignores this flag.
   */
  forUpdate?: boolean;
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
   * Internal: parent's pending post-commit rule side-effect arrays for a shared
   * transaction. A nested action inside a parent tx bubbles its collected
   * `execute_action` / `trigger_flow` effects here so they run when the PARENT
   * commits, instead of firing before the (not-yet-committed) parent write.
   */
  _parentPendingRuleActions?: ExecuteActionEffect[];
  _parentPendingRuleFlows?: TriggerFlowEffect[];
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

/**
 * Minimal approval surface the executor needs to suspend an action when a
 * `require_approval` rule effect fires. Kept structural (a subset of
 * ApprovalEngine.createRequest's options) rather than importing `ApprovalEngine`
 * directly, because approval-engine.ts imports `ActionExecutor` from here — a
 * structural type avoids the module cycle while staying type-checked against the
 * canonical {@link RequireApprovalEffect} / {@link ApprovalPendingResult}.
 */
export interface ActionApprovalSuspender {
  createRequest(options: {
    action: string;
    entity?: string;
    recordId?: string;
    input: Record<string, unknown>;
    actor: Actor;
    executionId: string;
    effect: RequireApprovalEffect;
    triggerRules: string[];
    tenantId?: string;
    meta?: Record<string, unknown>;
  }): Promise<ApprovalPendingResult>;
}

/**
 * Minimal flow surface the executor needs to start a durable Flow as a
 * post-commit `trigger_flow` rule side effect. Structural (a subset of
 * FlowEngine) so the executor doesn't depend on the flow engine implementation.
 */
export interface ActionFlowStarter {
  startFlow(
    flowName: string,
    input: Record<string, unknown>,
    options?: { tenantId?: string; actor?: Actor },
  ): Promise<unknown>;
}

export interface ActionExecutor {
  readonly registry: ActionRegistry;

  execute<T = unknown>(
    actionName: string,
    input: Record<string, unknown>,
    actor: Actor,
    options?: ExecuteOptions,
  ): Promise<ActionResult<T>>;

  /**
   * Late-bind the approval engine used to suspend actions on `require_approval`
   * rule effects. Deferred because the executor and the approval engine are
   * mutually dependent (the engine re-executes actions via this executor), so
   * one must be constructed first and wired to the other afterwards.
   */
  setApprovalEngine(engine: ActionApprovalSuspender): void;

  /**
   * Late-bind the flow engine used to start durable Flows on `trigger_flow`
   * rule effects (post-commit, fire-and-forget). Optional — when unset, a
   * trigger_flow effect is logged and skipped (no flow is started).
   */
  setFlowEngine(engine: ActionFlowStarter): void;
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
  /**
   * Interceptor registry for value-returning core extension points (Spec 63
   * Phase 3). Currently wires the `field-lock-check` point: a policy
   * capability can transform the field-lock violation set (shadow / bypass /
   * tolerance) before the engine throws. When omitted — or when no
   * `field-lock-check` interceptor is registered — the lock check behaves
   * byte-for-byte as Phase 1 (the registry's `run` is an identity).
   */
  interceptorRegistry?: InterceptorRegistry;
  /**
   * When true (production/staging), action input is validated against a Zod
   * schema generated from the action's `input` field definitions — types +
   * constraints, not just required-presence. Defaults to false (dev/test stay
   * lenient with toy inputs). The generated schema mirrors the on-the-wire
   * shape (ISO strings for dates, arbitrary objects for `json`, unknown keys
   * stripped), so it never rejects a value a real HTTP/GraphQL client could
   * legitimately send.
   */
  strictValidation?: boolean;
  /**
   * Business rules (`defineRule`) evaluated during action execution
   * (Spec 23 §1.1). When omitted, no rule evaluation runs — back-compat for
   * tests and minimal setups. Production wiring injects the capability-
   * aggregated rule set. Only rules whose `trigger.action` targets the running
   * action fire (filtered by `collectRules`). In this phase, `block` aborts the
   * write, `enrich` augments the input, and `warn` surfaces on the result;
   * `require_approval` / `execute_action` / `trigger_flow` are handled in
   * follow-up phases.
   */
  rules?: RuleDefinition[];
  /**
   * Approval engine used to suspend an action when a `require_approval` rule
   * effect fires (Spec 23 §1.1 / Spec 09). Optional — when omitted, a
   * require_approval effect lets the action proceed (no silent hard block).
   * May also be wired after construction via `executor.setApprovalEngine` to
   * break the executor ↔ approval-engine dependency cycle.
   */
  approvalEngine?: ActionApprovalSuspender;
  /**
   * Flow engine used to start durable Flows on `trigger_flow` rule effects
   * (post-commit, fire-and-forget). Optional — when omitted, a trigger_flow
   * effect is logged and skipped. May also be wired after construction via
   * `executor.setFlowEngine`.
   */
  flowEngine?: ActionFlowStarter;
}
