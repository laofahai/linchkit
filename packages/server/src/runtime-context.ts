/**
 * Runtime Context — assembles all core engines into a single context.
 *
 * Provides a convenient factory for creating a fully-wired runtime
 * with SchemaRegistry, ActionExecutor, EventBus, InMemoryStore, and ExecutionLogger.
 */

import {
  type ActionDefinition,
  type ActionExecutor,
  type AIService,
  type AIServiceConfig,
  type CommandLayer,
  createActionExecutor,
  createAIService,
  createCommandLayer,
  createNoopAIService,
  createStateMachine,
  type ExecutionLogger,
  InMemoryExecutionLogger,
  type MiddlewareRegistration,
  type SchemaDefinition,
  SchemaRegistry,
  type StateDefinition,
  type ViewDefinition,
} from "@linchkit/core";
import { InMemoryStore } from "./data/in-memory-store";

export interface RuntimeContext {
  schemaRegistry: SchemaRegistry;
  executor: ActionExecutor;
  commandLayer: CommandLayer;
  store: InMemoryStore;
  executionLogger: ExecutionLogger;
  /** View definitions grouped by schema name */
  views: Map<string, ViewDefinition[]>;
  /** AI service — noop if not configured */
  ai: AIService;
}

export interface RuntimeContextOptions {
  schemas?: SchemaDefinition[];
  actions?: ActionDefinition[];
  states?: StateDefinition[];
  views?: ViewDefinition[];
  middlewares?: MiddlewareRegistration[];
  /** AI service configuration (optional — system works without it) */
  ai?: AIServiceConfig;
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
  const store = new InMemoryStore();
  const executionLogger = new InMemoryExecutionLogger();
  const schemaRegistry = new SchemaRegistry();

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
    dataProvider: store,
    stateMachine,
    executionLogger,
    aiService: ai,
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
    store,
    executionLogger,
    views,
    ai,
  };
}
