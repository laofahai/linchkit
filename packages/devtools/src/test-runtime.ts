/**
 * Test runtime utilities for capability developers.
 *
 * - createTestRuntime() — minimal runtime context with InMemoryDataProvider
 * - createTestActor() — default Actor for test scenarios
 * - mockAIService() — mock AI service with configurable responses
 */

import type {
  ActionDefinition,
  ActionExecutor,
  ActionRegistry,
  Actor,
  AICompletionOptions,
  AICompletionResult,
  AIService,
  CapabilityDefinition,
  DataProvider,
  EventBus,
  SchemaDefinition,
  SchemaRegistry,
} from "@linchkit/core";
import { createActionExecutor, createEventBus, createSchemaRegistry } from "@linchkit/core/server";

// ── InMemoryDataProvider ────────────────────────────────────

/** Minimal in-memory data provider for testing */
function createInMemoryDataProvider(): DataProvider {
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  return {
    async get(schema: string, id: string) {
      const table = data.get(schema);
      const record = table?.get(id);
      if (!record) throw new Error(`Record ${schema}/${id} not found`);
      return record;
    },
    async query(schema: string, _filter: Record<string, unknown>) {
      const table = data.get(schema);
      if (!table) return [];
      return Array.from(table.values());
    },
    async create(schema: string, input: Record<string, unknown>) {
      if (!data.has(schema)) data.set(schema, new Map());
      counter++;
      const id = (input.id as string) ?? `test_${counter}`;
      const record = {
        id,
        ...input,
        _version: 1,
        tenant_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const table = data.get(schema);
      if (!table) throw new Error(`Unreachable: data missing key ${schema}`);
      table.set(id, record);
      return record;
    },
    async update(schema: string, id: string, updates: Record<string, unknown>) {
      const table = data.get(schema);
      const record = table?.get(id);
      if (!record) throw new Error(`Record ${schema}/${id} not found`);
      Object.assign(record, updates);
      return record;
    },
    async delete(schema: string, id: string) {
      data.get(schema)?.delete(id);
    },
    async count(schema: string, _filter?: Record<string, unknown>) {
      const table = data.get(schema);
      return table ? table.size : 0;
    },
  };
}

// ── TestRuntime ─────────────────────────────────────────────

export interface TestRuntimeOptions {
  schemas?: SchemaDefinition[];
  actions?: ActionDefinition[];
  capabilities?: CapabilityDefinition[];
}

export interface TestRuntime {
  executor: ActionExecutor;
  dataProvider: DataProvider;
  schemaRegistry: SchemaRegistry;
  eventBus: EventBus;
  actionRegistry: ActionRegistry;
}

/**
 * Create a minimal runtime context for testing.
 *
 * Registers provided schemas and actions, wires up an InMemoryDataProvider,
 * and returns all the pieces a capability test typically needs.
 */
export function createTestRuntime(options?: TestRuntimeOptions): TestRuntime {
  const dataProvider = createInMemoryDataProvider();
  const schemaRegistry = createSchemaRegistry();
  const { bus: eventBus } = createEventBus();
  const executor = createActionExecutor({ dataProvider });

  // Register schemas
  if (options?.schemas) {
    for (const schema of options.schemas) {
      schemaRegistry.register(schema);
    }
  }

  // Register actions
  if (options?.actions) {
    for (const action of options.actions) {
      executor.registry.register(action);
    }
  }

  // Register capabilities (schemas + actions from each)
  if (options?.capabilities) {
    for (const cap of options.capabilities) {
      if (cap.schemas) {
        for (const schema of cap.schemas) {
          schemaRegistry.register(schema);
        }
      }
      if (cap.actions) {
        for (const action of cap.actions) {
          executor.registry.register(action);
        }
      }
    }
  }

  return {
    executor,
    dataProvider,
    schemaRegistry,
    eventBus,
    actionRegistry: executor.registry,
  };
}

// ── createTestActor ─────────────────────────────────────────

/**
 * Create a test Actor with sensible defaults.
 *
 * Default: `{ type: 'human', id: 'test-user', name: 'Test User', groups: ['admin'] }`
 */
export function createTestActor(overrides?: Partial<Actor>): Actor {
  return {
    type: "human",
    id: "test-user",
    name: "Test User",
    groups: ["admin"],
    ...overrides,
  };
}

// ── mockAIService ───────────────────────────────────────────

export interface MockAIService extends AIService {
  /** All calls recorded for assertions */
  calls: AICompletionOptions[];
  /** Number of times complete() was called */
  callCount: number;
}

/**
 * Create a mock AI service for testing flows with AI steps.
 *
 * @param responses - Map of prompt substring → response content.
 *   When a message contains the substring, that response is returned.
 *   If no match, returns a default "mock response".
 */
export function mockAIService(responses?: Record<string, unknown>): MockAIService {
  const calls: AICompletionOptions[] = [];

  return {
    calls,
    get callCount() {
      return calls.length;
    },
    async complete(options: AICompletionOptions): Promise<AICompletionResult> {
      calls.push(options);

      // Try to match a response based on message content
      let content = "mock response";
      let data: unknown;

      if (responses) {
        const lastUserMessage = [...options.messages].reverse().find((m) => m.role === "user");
        const messageText = lastUserMessage?.content ?? "";

        for (const [key, value] of Object.entries(responses)) {
          if (messageText.includes(key)) {
            if (typeof value === "string") {
              content = value;
            } else {
              content = JSON.stringify(value);
              data = value;
            }
            break;
          }
        }
      }

      return {
        content,
        data,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
        model: "mock-model",
        provider: "mock-provider",
        duration: 0,
      };
    },
  };
}
