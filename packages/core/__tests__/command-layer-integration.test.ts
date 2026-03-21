/**
 * Command Layer — integration tests.
 *
 * Covers: middleware not calling next(), input mutation, skipPipelineChecks, executionId.
 */

import { describe, expect, test } from "bun:test";
import { createTestSetup } from "./command-layer-helpers";

describe("Command Layer: Integration", () => {
	describe("Middleware not calling next()", () => {
		test("pre-action middleware not calling next() — action still runs", async () => {
			const { layer } = createTestSetup();

			layer.use({
				name: "cache_hit",
				slot: "pre-action",
				handler: async (_ctx, _next) => {
					// Intentionally do NOT call next()
				},
			});

			const result = await layer.execute({
				command: "create_item",
				input: { name: "test" },
			});

			// Action still runs — not calling next() only stops chaining within composed handlers
			expect(result.success).toBe(true);
		});

		test("auth middleware not calling next() — permission slot skipped but action still runs", async () => {
			const { layer } = createTestSetup();
			let permissionRan = false;

			layer.use({
				name: "blocking_auth",
				slot: "auth",
				handler: async (_ctx, _next) => {
					// Returns without calling next
				},
			});

			layer.use({
				name: "perm",
				slot: "permission",
				handler: async (_ctx, next) => {
					permissionRan = true;
					await next();
				},
			});

			const result = await layer.execute({
				command: "create_item",
				input: { name: "test" },
			});

			// Action runs because the pipeline compose and action execution are separate steps
			expect(result.success).toBe(true);
			// But downstream middleware in the composed chain was skipped
			expect(permissionRan).toBe(false);
		});
	});

	describe("Input mutation by middleware", () => {
		test("pre-action middleware can enrich input and changes are seen by action", async () => {
			const { layer } = createTestSetup();

			layer.use({
				name: "input_enricher",
				slot: "pre-action",
				handler: async (ctx, next) => {
					ctx.input.enriched = true;
					ctx.input.source = "middleware";
					await next();
				},
			});

			const result = await layer.execute({
				command: "create_item",
				input: { name: "enriched_item" },
			});

			expect(result.success).toBe(true);
			const data = result.data as Record<string, unknown>;
			expect(data).toBeDefined();
			expect(data.enriched).toBe(true);
			expect(data.source).toBe("middleware");
		});
	});

	describe("skipPipelineChecks", () => {
		test("executor skips exposure/permission when called via command layer", async () => {
			const { layer } = createTestSetup();

			// admin_action requires group "admin"
			// Anonymous actor has no groups
			// Pipeline permission middleware intentionally passes
			layer.use({
				name: "lenient_perm",
				slot: "permission",
				handler: async (_ctx, next) => {
					await next();
				},
			});

			const result = await layer.execute({
				command: "admin_action",
				input: {},
			});

			// Without skipPipelineChecks, executor would reject (anonymous has no "admin" group)
			// With skipPipelineChecks, executor trusts the pipeline's decision
			expect(result.success).toBe(true);
		});
	});

	describe("executionId for pipeline errors", () => {
		test("pipeline error returns a non-empty executionId with pipeline_ prefix", async () => {
			const { layer } = createTestSetup();

			const result = await layer.execute({
				command: "nonexistent_action",
				input: {},
			});

			expect(result.success).toBe(false);
			expect(result.executionId).toBeTruthy();
			expect(result.executionId.startsWith("pipeline_")).toBe(true);
		});
	});
});
