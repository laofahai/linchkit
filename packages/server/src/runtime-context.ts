/**
 * Runtime Context — assembles all core engines into a single context.
 *
 * Provides a convenient factory for creating a fully-wired runtime
 * with SchemaRegistry, ActionExecutor, EventBus, InMemoryStore, and ExecutionLogger.
 */

import {
	type ActionExecutor,
	type CommandLayer,
	type MiddlewareRegistration,
	InMemoryExecutionLogger,
	SchemaRegistry,
	createActionExecutor,
	createCommandLayer,
	createStateMachine,
	type ExecutionLogger,
	type SchemaDefinition,
	type ActionDefinition,
	type StateDefinition,
} from "@linchkit/core";
import { InMemoryStore } from "./data/in-memory-store";

export interface RuntimeContext {
	schemaRegistry: SchemaRegistry;
	executor: ActionExecutor;
	commandLayer: CommandLayer;
	store: InMemoryStore;
	executionLogger: ExecutionLogger;
}

export interface RuntimeContextOptions {
	schemas?: SchemaDefinition[];
	actions?: ActionDefinition[];
	states?: StateDefinition[];
	middlewares?: MiddlewareRegistration[];
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
	const stateMachine = firstState
		? createStateMachine(firstState)
		: undefined;

	const executor = createActionExecutor({
		dataProvider: store,
		stateMachine,
		executionLogger,
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

	return {
		schemaRegistry,
		executor,
		commandLayer,
		store,
		executionLogger,
	};
}
