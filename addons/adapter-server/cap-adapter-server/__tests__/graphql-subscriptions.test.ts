/**
 * Tests for GraphQL subscription schema generation and EventBus-PubSub wiring.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { EntityDefinition, EventRecord } from "@linchkit/core";
import { createEventBus } from "@linchkit/core/server";
import { type GraphQLObjectType, printSchema } from "graphql";
import { clearEnumTypeCache } from "../src/graphql";
import { buildGraphQLSchema } from "../src/graphql/build-schema";
import {
  buildSubscriptionFields,
  buildTopic,
  createEventBusPubSub,
} from "../src/graphql/build-subscriptions";
import { generateGraphQLObjectType } from "../src/graphql/schema-to-graphql";

// Clear enum cache between tests
afterEach(() => {
  clearEnumTypeCache();
});

// ── Test fixtures ────────────────────────────────────────

const taskSchema: EntityDefinition = {
  name: "task",
  label: "Task",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
  },
};

const purchaseRequestSchema: EntityDefinition = {
  name: "purchase_request",
  label: "Purchase Request",
  fields: {
    title: { type: "string", required: true },
    amount: { type: "number", required: true },
    status: { type: "state", machine: "purchase_lifecycle" },
  },
};

// ── buildTopic ───────────────────────────────────────────

describe("buildTopic", () => {
  test("generates correct topic string", () => {
    expect(buildTopic("task", "created")).toBe("task.created");
    expect(buildTopic("purchase_request", "updated")).toBe("purchase_request.updated");
    expect(buildTopic("task", "deleted")).toBe("task.deleted");
  });
});

// ── createEventBusPubSub ─────────────────────────────────

describe("createEventBusPubSub", () => {
  test("creates pubsub and returns unsubscribe function", () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);
    expect(pubsub).toBeDefined();
    expect(typeof pubsub.publish).toBe("function");
    expect(typeof pubsub.subscribe).toBe("function");
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  test("publishes created event to correct topic", async () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);

    // Subscribe to the topic before emitting
    const iterator = pubsub.subscribe("task.created");

    // Start waiting for the next value BEFORE emitting (Repeater buffers events)
    const nextPromise = iterator.next();

    // Emit event on EventBus
    const event: EventRecord = {
      id: "evt-1",
      type: "record.created",
      category: "change",
      timestamp: new Date(),
      actor: { type: "user", id: "user-1" },
      executionId: "exec-1",
      entity: "task",
      recordId: "task-1",
      payload: { title: "Test Task", description: "A test" },
    };
    await bus.emit(event);

    // Give async handler time to run
    await new Promise((r) => setTimeout(r, 50));

    // Read from iterator with timeout
    const result = await Promise.race([
      nextPromise,
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 500),
      ),
    ]);

    expect(result.done).toBe(false);
    expect(result.value).toBeDefined();
    expect((result.value as Record<string, unknown>).id).toBe("task-1");
    expect((result.value as Record<string, unknown>).schema).toBe("task");
    expect((result.value as Record<string, unknown>).title).toBe("Test Task");

    iterator.return?.();
    unsubscribe();
  });

  test("publishes deleted event with id and schema only", async () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);

    const iterator = pubsub.subscribe("task.deleted");

    // Start waiting before emitting
    const nextPromise = iterator.next();

    const event: EventRecord = {
      id: "evt-2",
      type: "record.deleted",
      category: "change",
      timestamp: new Date(),
      actor: { type: "user", id: "user-1" },
      executionId: "exec-2",
      entity: "task",
      recordId: "task-1",
      payload: { id: "task-1" },
    };
    await bus.emit(event);
    await new Promise((r) => setTimeout(r, 50));

    const result = await Promise.race([
      nextPromise,
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), 500),
      ),
    ]);

    expect(result.done).toBe(false);
    expect((result.value as Record<string, unknown>).id).toBe("task-1");
    expect((result.value as Record<string, unknown>).schema).toBe("task");
    // Should NOT include extra payload fields for deleted events
    expect((result.value as Record<string, unknown>).title).toBeUndefined();

    iterator.return?.();
    unsubscribe();
  });

  test("ignores events without schema field", async () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);

    const iterator = pubsub.subscribe("task.created");

    // Event without schema — should be ignored
    const event: EventRecord = {
      id: "evt-3",
      type: "record.created",
      category: "change",
      timestamp: new Date(),
      actor: { type: "system", id: "test" },
      executionId: "exec-3",
      payload: { title: "No schema" },
    };
    await bus.emit(event);
    await new Promise((r) => setTimeout(r, 50));

    // Should timeout — no event published
    const result = await Promise.race([
      iterator.next(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);

    expect(result).toBe("timeout");

    iterator.return?.();
    unsubscribe();
  });
});

// ── buildSubscriptionFields ──────────────────────────────

describe("buildSubscriptionFields", () => {
  test("returns null for empty schemas", () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);
    const result = buildSubscriptionFields({
      entities: [],
      entityObjectTypes: new Map(),
      pubsub,
    });
    expect(result).toBeNull();
    unsubscribe();
  });

  test("generates Created/Updated/Deleted fields for each schema", () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);

    const taskType = generateGraphQLObjectType(taskSchema);
    const entityObjectTypes = new Map<string, GraphQLObjectType>();
    entityObjectTypes.set("task", taskType);

    const fields = buildSubscriptionFields({
      entities: [taskSchema],
      entityObjectTypes,
      pubsub,
    });

    expect(fields).not.toBeNull();
    expect(fields).toHaveProperty("onTaskCreated");
    expect(fields).toHaveProperty("onTaskUpdated");
    expect(fields).toHaveProperty("onTaskDeleted");
    unsubscribe();
  });

  test("generates correct field names for snake_case schema names", () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);

    const prType = generateGraphQLObjectType(purchaseRequestSchema);
    const entityObjectTypes = new Map<string, GraphQLObjectType>();
    entityObjectTypes.set("purchase_request", prType);

    const fields = buildSubscriptionFields({
      entities: [purchaseRequestSchema],
      entityObjectTypes,
      pubsub,
    });

    expect(fields).not.toBeNull();
    expect(fields).toHaveProperty("onPurchaseRequestCreated");
    expect(fields).toHaveProperty("onPurchaseRequestUpdated");
    expect(fields).toHaveProperty("onPurchaseRequestDeleted");
    unsubscribe();
  });

  test("subscription fields have subscribe and resolve functions", () => {
    const { bus } = createEventBus();
    const { pubsub, unsubscribe } = createEventBusPubSub(bus);

    const taskType = generateGraphQLObjectType(taskSchema);
    const entityObjectTypes = new Map<string, GraphQLObjectType>();
    entityObjectTypes.set("task", taskType);

    const fields = buildSubscriptionFields({
      entities: [taskSchema],
      entityObjectTypes,
      pubsub,
    });

    expect(fields).not.toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: test access to internal structure
    const created = fields?.onTaskCreated as any;
    expect(typeof created.subscribe).toBe("function");
    expect(typeof created.resolve).toBe("function");
    unsubscribe();
  });
});

// ── buildGraphQLSchema with subscriptions ────────────────

describe("buildGraphQLSchema with eventBus", () => {
  test("schema includes Subscription type when eventBus is provided", () => {
    const { bus } = createEventBus();
    const schema = buildGraphQLSchema([taskSchema], { eventBus: bus });
    const subscriptionType = schema.getSubscriptionType();
    expect(subscriptionType).toBeDefined();
    expect(subscriptionType?.name).toBe("Subscription");
  });

  test("schema has no Subscription type when eventBus is not provided", () => {
    const schema = buildGraphQLSchema([taskSchema]);
    const subscriptionType = schema.getSubscriptionType();
    expect(subscriptionType).toBeUndefined();
  });

  test("subscription fields appear in printed schema", () => {
    const { bus } = createEventBus();
    const schema = buildGraphQLSchema([taskSchema], { eventBus: bus });
    const printed = printSchema(schema);

    expect(printed).toContain("type Subscription");
    expect(printed).toContain("onTaskCreated");
    expect(printed).toContain("onTaskUpdated");
    expect(printed).toContain("onTaskDeleted");
  });

  test("DeletedRecord type appears in schema", () => {
    const { bus } = createEventBus();
    const schema = buildGraphQLSchema([taskSchema], { eventBus: bus });
    const printed = printSchema(schema);

    expect(printed).toContain("type DeletedRecord");
    expect(printed).toContain("id: ID!");
    // DeletedRecord has schema field
    expect(printed).toMatch(/type DeletedRecord[\s\S]*?schema: String!/);
  });

  test("multiple schemas generate separate subscription fields", () => {
    const { bus } = createEventBus();
    const schema = buildGraphQLSchema([taskSchema, purchaseRequestSchema], { eventBus: bus });
    const printed = printSchema(schema);

    expect(printed).toContain("onTaskCreated");
    expect(printed).toContain("onPurchaseRequestCreated");
    expect(printed).toContain("onPurchaseRequestUpdated");
    expect(printed).toContain("onPurchaseRequestDeleted");
  });
});
