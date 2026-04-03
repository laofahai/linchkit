import { describe, expect, it } from "bun:test";
import { defineAction, defineEntity } from "@linchkit/core";
import { createTestActor, createTestRuntime, mockAIService } from "../src/test-runtime";

describe("createTestRuntime", () => {
  it("should return all expected properties", () => {
    const runtime = createTestRuntime();

    expect(runtime.executor).toBeDefined();
    expect(runtime.dataProvider).toBeDefined();
    expect(runtime.entityRegistry).toBeDefined();
    expect(runtime.eventBus).toBeDefined();
    expect(runtime.actionRegistry).toBeDefined();
    expect(typeof runtime.executor.execute).toBe("function");
  });

  it("should register provided schemas", () => {
    const schema = defineEntity({
      name: "task",
      label: "Task",
      fields: {
        title: { type: "string", required: true, label: "Title" },
      },
    });

    const runtime = createTestRuntime({ schemas: [schema] });
    const resolved = runtime.entityRegistry.resolve("task");

    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe("task");
  });

  it("should register provided actions", () => {
    const action = defineAction({
      name: "do_something",
      schema: "task",
      label: "Do Something",
      policy: { mode: "sync", transaction: false },
      handler: async () => ({ done: true }),
    });

    const runtime = createTestRuntime({ actions: [action] });
    const found = runtime.actionRegistry.get("do_something");

    expect(found).toBeDefined();
    expect(found?.name).toBe("do_something");
  });

  it("should execute actions with InMemoryDataProvider", async () => {
    const action = defineAction({
      name: "create_item",
      schema: "item",
      label: "Create Item",
      policy: { mode: "sync", transaction: false },
      handler: async (ctx) => {
        return ctx.create("item", ctx.input);
      },
    });

    const runtime = createTestRuntime({ actions: [action] });
    const actor = createTestActor();
    const result = await runtime.executor.execute("create_item", { title: "Test" }, actor);

    expect(result.success).toBe(true);
  });
});

describe("createTestActor", () => {
  it("should return valid Actor with defaults", () => {
    const actor = createTestActor();

    expect(actor.type).toBe("human");
    expect(actor.id).toBe("test-user");
    expect(actor.name).toBe("Test User");
    expect(actor.groups).toEqual(["admin"]);
  });

  it("should apply overrides", () => {
    const actor = createTestActor({
      type: "ai",
      id: "bot-1",
      name: "Bot Agent",
      groups: ["agent", "viewer"],
    });

    expect(actor.type).toBe("ai");
    expect(actor.id).toBe("bot-1");
    expect(actor.name).toBe("Bot Agent");
    expect(actor.groups).toEqual(["agent", "viewer"]);
  });

  it("should apply partial overrides", () => {
    const actor = createTestActor({ id: "custom-id" });

    expect(actor.type).toBe("human");
    expect(actor.id).toBe("custom-id");
    expect(actor.name).toBe("Test User");
    expect(actor.groups).toEqual(["admin"]);
  });
});

describe("mockAIService", () => {
  it("should return default mock response when no responses configured", async () => {
    const ai = mockAIService();
    const result = await ai.complete({
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.content).toBe("mock response");
    expect(result.model).toBe("mock-model");
    expect(result.provider).toBe("mock-provider");
    expect(result.usage.totalTokens).toBe(30);
  });

  it("should return configured responses based on message content", async () => {
    const ai = mockAIService({
      summarize: "This is a summary.",
      translate: "Translated text.",
    });

    const result = await ai.complete({
      messages: [{ role: "user", content: "Please summarize this document" }],
    });

    expect(result.content).toBe("This is a summary.");
  });

  it("should handle object responses and set data field", async () => {
    const ai = mockAIService({
      classify: { category: "urgent", confidence: 0.95 },
    });

    const result = await ai.complete({
      messages: [{ role: "user", content: "classify this ticket" }],
    });

    expect(result.data).toEqual({ category: "urgent", confidence: 0.95 });
  });

  it("should track call count and recorded calls", async () => {
    const ai = mockAIService();

    expect(ai.callCount).toBe(0);

    await ai.complete({
      messages: [{ role: "user", content: "first" }],
    });
    await ai.complete({
      messages: [{ role: "user", content: "second" }],
    });

    expect(ai.callCount).toBe(2);
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[0].messages[0].content).toBe("first");
    expect(ai.calls[1].messages[0].content).toBe("second");
  });

  it("should return default response when no message matches", async () => {
    const ai = mockAIService({
      summarize: "summary result",
    });

    const result = await ai.complete({
      messages: [{ role: "user", content: "unrelated request" }],
    });

    expect(result.content).toBe("mock response");
  });
});
