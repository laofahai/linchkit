/**
 * RuntimeContext unit tests.
 *
 * Verifies createRuntimeContext() correctly assembles all engines and
 * registers schemas/actions.
 */

import { describe, expect, test } from "bun:test";
import { InMemoryExecutionLogger } from "@linchkit/core";
import type { ActionDefinition, SchemaDefinition } from "@linchkit/core";
import { createRuntimeContext } from "../src/runtime-context";
import { InMemoryStore } from "../src/data/in-memory-store";

// ── Fixtures ──────────────────────────────────────────────

const orderSchema: SchemaDefinition = {
	name: "order",
	label: "Order",
	fields: {
		total: { type: "number", required: true, label: "Total" },
		status: { type: "string", label: "Status" },
	},
};

const productSchema: SchemaDefinition = {
	name: "product",
	label: "Product",
	fields: {
		name: { type: "string", required: true, label: "Name" },
		price: { type: "number", label: "Price" },
	},
};

const createOrderAction: ActionDefinition = {
	name: "create_order",
	schema: "order",
	label: "Create Order",
	policy: { mode: "sync", transaction: false },
	handler: async (ctx) => {
		return ctx.create("order", ctx.input);
	},
};

const cancelOrderAction: ActionDefinition = {
	name: "cancel_order",
	schema: "order",
	label: "Cancel Order",
	policy: { mode: "sync", transaction: false },
	handler: async (ctx) => {
		return ctx.update("order", ctx.input.id as string, { status: "cancelled" });
	},
};

// ── Tests ─────────────────────────────────────────────────

describe("createRuntimeContext", () => {
	test("creates a context with default (empty) options", () => {
		const ctx = createRuntimeContext();

		expect(ctx.schemaRegistry).toBeDefined();
		expect(ctx.executor).toBeDefined();
		expect(ctx.store).toBeDefined();
		expect(ctx.executionLogger).toBeDefined();
	});

	test("store is an InMemoryStore instance", () => {
		const ctx = createRuntimeContext();
		expect(ctx.store).toBeInstanceOf(InMemoryStore);
	});

	test("executionLogger is an InMemoryExecutionLogger instance", () => {
		const ctx = createRuntimeContext();
		expect(ctx.executionLogger).toBeInstanceOf(InMemoryExecutionLogger);
	});

	test("registers provided schemas", () => {
		const ctx = createRuntimeContext({
			schemas: [orderSchema, productSchema],
		});

		const order = ctx.schemaRegistry.get("order");
		expect(order).toBeDefined();
		expect(order!.name).toBe("order");

		const product = ctx.schemaRegistry.get("product");
		expect(product).toBeDefined();
		expect(product!.name).toBe("product");
	});

	test("registers provided actions", () => {
		const ctx = createRuntimeContext({
			actions: [createOrderAction, cancelOrderAction],
		});

		expect(ctx.executor.registry.has("create_order")).toBe(true);
		expect(ctx.executor.registry.has("cancel_order")).toBe(true);
	});

	test("executor can execute a registered action", async () => {
		const ctx = createRuntimeContext({
			actions: [createOrderAction],
		});

		const actor = { type: "human" as const, id: "test_user", groups: ["admin"] };
		const result = await ctx.executor.execute(
			"create_order",
			{ total: 100, status: "draft" },
			actor,
		);

		expect(result.success).toBe(true);
		expect(result.executionId).toBeDefined();
	});

	test("executor returns failure for unregistered action", async () => {
		const ctx = createRuntimeContext();

		const actor = { type: "human" as const, id: "test_user", groups: ["admin"] };
		const result = await ctx.executor.execute("unknown_action", {}, actor);

		expect(result.success).toBe(false);
		const data = result.data as Record<string, unknown>;
		expect((data.error as string)).toContain("not found");
	});

	test("executionLogger records executions", async () => {
		const ctx = createRuntimeContext({
			actions: [createOrderAction],
		});

		const actor = { type: "human" as const, id: "test_user", groups: ["admin"] };
		await ctx.executor.execute("create_order", { total: 50 }, actor);

		const logger = ctx.executionLogger as InMemoryExecutionLogger;
		expect(logger.size).toBeGreaterThanOrEqual(1);

		const entries = logger.getAll();
		const entry = entries.find((e) => e.action === "create_order");
		expect(entry).toBeDefined();
		expect(entry!.status).toBe("succeeded");
		expect(entry!.actor).toEqual(actor);
	});

	test("multiple schemas and actions can coexist", () => {
		const ctx = createRuntimeContext({
			schemas: [orderSchema, productSchema],
			actions: [createOrderAction, cancelOrderAction],
		});

		expect(ctx.schemaRegistry.get("order")).toBeDefined();
		expect(ctx.schemaRegistry.get("product")).toBeDefined();
		expect(ctx.executor.registry.has("create_order")).toBe(true);
		expect(ctx.executor.registry.has("cancel_order")).toBe(true);
	});
});
