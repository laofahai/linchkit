/**
 * Runtime Context — assembles all core engines into a single context.
 *
 * Provides a convenient factory for creating a fully-wired runtime
 * with EntityRegistry, ActionExecutor, EventBus, DataProvider, and ExecutionLogger.
 * When an external dataProvider is supplied (e.g. DrizzleDataProvider), it is used
 * for both the action executor AND GraphQL query resolvers.
 * Falls back to InMemoryStore only when no external provider is given.
 */

import type {
  ActionDefinition,
  ActionExecutor,
  ActionFlowStarter,
  AIService,
  ApprovalEngine,
  ApprovalStore,
  CommandLayer,
  DataProvider,
  EntityDefinition,
  EventBus,
  ExecutionLogger,
  InterfaceDefinition,
  MiddlewareRegistration,
  RuleDefinition,
  StateDefinition,
  TransactionManager,
  ViewDefinition,
} from "@linchkit/core";
import {
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createCommandLayer,
  createInterfaceRegistry,
  createNoopAIService,
  createStateMachine,
  detectEnvironment,
  EntityRegistry,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";

export interface RuntimeContext {
  entityRegistry: EntityRegistry;
  executor: ActionExecutor;
  commandLayer: CommandLayer;
  /**
   * Approval engine for `require_approval` rule effects. Wired into the
   * executor so an action suspends into an approval request, and re-executes
   * via the CommandLayer on approve. Uses an in-memory store by default —
   * persistence (DrizzleApprovalStore) is injected by the boot path.
   */
  approvalEngine: ApprovalEngine;
  /** DataProvider used by both action executor and GraphQL query resolvers */
  dataProvider: DataProvider;
  executionLogger: ExecutionLogger;
  /** View definitions grouped by schema name */
  views: Map<string, ViewDefinition[]>;
  /** AI service — noop if not configured */
  ai: AIService;
  /** Event bus for cross-capability event dispatch */
  eventBus?: EventBus;
}

export interface RuntimeContextOptions {
  entities?: EntityDefinition[];
  actions?: ActionDefinition[];
  states?: StateDefinition[];
  views?: ViewDefinition[];
  /** Business rules (defineRule) — evaluated by the action executor (Spec 23 §1.1). */
  rules?: RuleDefinition[];
  /**
   * Approval store backing `require_approval` rule effects. Defaults to an
   * in-memory store (lost on restart); inject a `DrizzleApprovalStore` for
   * persistent approvals in production.
   */
  approvalStore?: ApprovalStore;
  /**
   * Flow starter used to start durable Flows on `trigger_flow` rule effects
   * (post-commit). The minimal `ActionFlowStarter` interface (a `FlowEngine`
   * satisfies it) — when omitted, trigger_flow rules are logged and skipped.
   */
  flowEngine?: ActionFlowStarter;
  middlewares?: MiddlewareRegistration[];
  /** Interface definitions — registered before schemas so field injection/validation works */
  interfaces?: InterfaceDefinition[];
  /** Pre-constructed AI service (optional — defaults to noop). Use createAIService() from @linchkit/cap-ai-provider to build one. */
  ai?: AIService;
  /** External data provider (e.g. DrizzleDataProvider). Falls back to InMemoryStore if not set. */
  dataProvider?: DataProvider;
  /** Event bus — PersistentEventBus when DB is available, plain EventBus otherwise */
  eventBus?: EventBus;
  /** Names of registered capabilities — enables ctx.hasCapability() for weak dependency checks */
  capabilityNames?: ReadonlySet<string>;
  /**
   * Transaction manager — wired into both the action executor and the
   * CommandLayer so `executeBatch` with the default `all_or_nothing`
   * strategy works without per-call plumbing. When omitted, batch callers
   * must pass `strategy: "partial"` (or supply a per-call manager).
   */
  transactionManager?: TransactionManager;
}

/**
 * Create a fully-wired RuntimeContext with all engines assembled.
 *
 * Usage:
 * ```ts
 * const ctx = createRuntimeContext({
 *   entities: [purchaseRequestSchema],
 *   actions: [...crudActions, submitAction],
 *   states: [purchaseLifecycle],
 * });
 * ```
 */
export function createRuntimeContext(options?: RuntimeContextOptions): RuntimeContext {
  // Use external data provider if provided, otherwise fall back to InMemoryStore
  const dataProvider: DataProvider = options?.dataProvider ?? new InMemoryStore();
  const executionLogger = new InMemoryExecutionLogger();
  const entityRegistry = new EntityRegistry();

  // Register interfaces BEFORE schemas so field injection and validation happen during registration
  if (options?.interfaces?.length) {
    const interfaceRegistry = createInterfaceRegistry();
    for (const iface of options.interfaces) {
      interfaceRegistry.register(iface);
    }
    entityRegistry.setInterfaceRegistry(interfaceRegistry);
  }

  // Register entities
  if (options?.entities) {
    for (const entity of options.entities) {
      entityRegistry.register(entity);
    }
  }

  // Build state machine if states are provided
  const firstState = options?.states?.[0];
  const stateMachine = firstState ? createStateMachine(firstState) : undefined;

  // Use provided AI service or fall back to noop
  const ai = options?.ai ?? createNoopAIService();

  const executor = createActionExecutor({
    dataProvider,
    stateMachine,
    executionLogger,
    aiService: ai,
    capabilityNames: options?.capabilityNames,
    entityRegistry,
    transactionManager: options?.transactionManager,
    // Strict type/constraint input validation in production + staging; dev/test
    // stay lenient (toy inputs). Sourced from the canonical environment policy.
    strictValidation: detectEnvironment().features.strictValidation,
    // Business rules evaluated during action execution (Spec 23 §1.1).
    rules: options?.rules,
  });

  // Register actions
  if (options?.actions) {
    for (const action of options.actions) {
      executor.registry.register(action);
    }
  }

  // Approval store — shared between the CommandLayer's approval verifier and
  // the approval engine so re-execution on approve is recognized as authorized.
  // Defaults to in-memory; the boot path can inject a DrizzleApprovalStore for
  // persistent approvals.
  const approvalStore = options?.approvalStore ?? new InMemoryApprovalStore();

  // Build command layer. The TM is plumbed through so `executeBatch` can run
  // `all_or_nothing` without per-call wiring; without one, batch callers must
  // use `strategy: "partial"` (the engine returns BATCH_TX_MANAGER_REQUIRED
  // otherwise). `verifyApproval` lets ApprovalEngine.approve() replay an action
  // through the pipeline (skipping auth/exposure/permission) via its approvalId.
  const commandLayer = createCommandLayer({
    executor,
    transactionManager: options?.transactionManager,
    verifyApproval: createApprovalVerifier(approvalStore),
  });
  if (options?.middlewares) {
    for (const mw of options.middlewares) {
      commandLayer.use(mw);
    }
  }

  // Approval engine for `require_approval` rule effects (Spec 23 §1.1).
  // Re-execution on approve routes through the CommandLayer. Wired both ways:
  // the engine re-executes via the executor, and the executor suspends actions
  // into the engine when a rule requires approval.
  const approvalEngine = createApprovalEngine({
    store: approvalStore,
    eventBus: options?.eventBus,
    commandLayer,
  });
  approvalEngine.setExecutor(executor);
  executor.setApprovalEngine(approvalEngine);

  // Wire the flow engine for `trigger_flow` rule effects when one is provided
  // (the boot path injects it; the server does not yet aggregate flows here).
  if (options?.flowEngine) {
    executor.setFlowEngine(options.flowEngine);
  }

  // Register views grouped by schema
  const views = new Map<string, ViewDefinition[]>();
  if (options?.views) {
    for (const view of options.views) {
      const list = views.get(view.entity) ?? [];
      list.push(view);
      views.set(view.entity, list);
    }
  }

  return {
    entityRegistry,
    executor,
    commandLayer,
    approvalEngine,
    dataProvider,
    executionLogger,
    views,
    ai,
    eventBus: options?.eventBus,
  };
}
