/**
 * Runtime Context — assembles all core engines into a single context.
 *
 * Provides a convenient factory for creating a fully-wired runtime
 * with SchemaRegistry, ActionExecutor, EventBus, DataProvider, and ExecutionLogger.
 * When an external dataProvider is supplied (e.g. DrizzleDataProvider), it is used
 * for both the action executor AND GraphQL query resolvers.
 * Falls back to InMemoryStore only when no external provider is given.
 */

import type {
  ActionDefinition,
  ActionExecutor,
  AIService,
  AIServiceConfig,
  CommandLayer,
  DataProvider,
  EventBus,
  ExecutionLogger,
  InterfaceDefinition,
  MiddlewareRegistration,
  SchemaDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";
import {
  createActionExecutor,
  createAIService,
  createCommandLayer,
  createInterfaceRegistry,
  createNoopAIService,
  createStateMachine,
  InMemoryExecutionLogger,
  SchemaRegistry,
  InMemoryStore,
} from "@linchkit/core/server";

export interface RuntimeContext {
  schemaRegistry: SchemaRegistry;
  executor: ActionExecutor;
  commandLayer: CommandLayer;
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
  schemas?: SchemaDefinition[];
  actions?: ActionDefinition[];
  states?: StateDefinition[];
  views?: ViewDefinition[];
  middlewares?: MiddlewareRegistration[];
  /** Interface definitions — registered before schemas so field injection/validation works */
  interfaces?: InterfaceDefinition[];
  /** AI service configuration (optional — system works without it) */
  ai?: AIServiceConfig;
  /** External data provider (e.g. DrizzleDataProvider). Falls back to InMemoryStore if not set. */
  dataProvider?: DataProvider;
  /** Event bus — PersistentEventBus when DB is available, plain EventBus otherwise */
  eventBus?: EventBus;
  /** Names of registered capabilities — enables ctx.hasCapability() for weak dependency checks */
  capabilityNames?: ReadonlySet<string>;
}

/**
 * Create a fully-wired RuntimeContext with all engines assembled.
 *
 * Usage:
 * ```ts
 * const ctx = createRuntimeContext({
 *   schemas: [purchaseRequestSchema],
 *   actions: [...crudActions, submitAction],
 *   states: [purchaseLifecycle],
 * });
 * ```
 */
export function createRuntimeContext(options?: RuntimeContextOptions): RuntimeContext {
  // Use external data provider if provided, otherwise fall back to InMemoryStore
  const dataProvider: DataProvider = options?.dataProvider ?? new InMemoryStore();
  const executionLogger = new InMemoryExecutionLogger();
  const schemaRegistry = new SchemaRegistry();

  // Register interfaces BEFORE schemas so field injection and validation happen during registration
  if (options?.interfaces?.length) {
    const interfaceRegistry = createInterfaceRegistry();
    for (const iface of options.interfaces) {
      interfaceRegistry.register(iface);
    }
    schemaRegistry.setInterfaceRegistry(interfaceRegistry);
  }

  // Register schemas
  if (options?.schemas) {
    for (const schema of options.schemas) {
      schemaRegistry.register(schema);
    }
  }

  // Build state machine if states are provided
  const firstState = options?.states?.[0];
  const stateMachine = firstState ? createStateMachine(firstState) : undefined;

  // Build AI service (optional — noop if not configured)
  const ai = options?.ai ? createAIService(options.ai) : createNoopAIService();

  const executor = createActionExecutor({
    dataProvider,
    stateMachine,
    executionLogger,
    aiService: ai,
    capabilityNames: options?.capabilityNames,
  });

  // Register actions
  if (options?.actions) {
    for (const action of options.actions) {
      executor.registry.register(action);
    }
  }

  // Build command layer
  const commandLayer = createCommandLayer({ executor });
  if (options?.middlewares) {
    for (const mw of options.middlewares) {
      commandLayer.use(mw);
    }
  }

  // Register views grouped by schema
  const views = new Map<string, ViewDefinition[]>();
  if (options?.views) {
    for (const view of options.views) {
      const list = views.get(view.schema) ?? [];
      list.push(view);
      views.set(view.schema, list);
    }
  }

  return {
    schemaRegistry,
    executor,
    commandLayer,
    dataProvider,
    executionLogger,
    views,
    ai,
    eventBus: options?.eventBus,
  };
}
