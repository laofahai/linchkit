/**
 * Main HTTP server setup — Elysia + graphql-yoga
 *
 * REST action endpoint returns proper HTTP status codes (see spec 16 §2.5).
 * GraphQL endpoint always returns 200 per GraphQL spec.
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { createYoga } from "graphql-yoga";
import type { GraphQLSchema } from "graphql";
import type { ActionExecutor, CommandLayer, ExecutionLogger, ExecutionStatus, SchemaRegistry } from "@linchkit/core";

export interface ServerOptions {
	/** Server port (default: 3001) */
	port?: number;
	/** Server host (default: "localhost") */
	host?: string;
	/** GraphQL endpoint path (default: "/graphql") */
	graphqlPath?: string;
	/** Action executor for REST endpoint */
	executor?: ActionExecutor;
	/** Command layer — if provided, REST actions go through the pipeline */
	commandLayer?: CommandLayer;
	/** Execution logger for log query endpoints */
	executionLogger?: ExecutionLogger;
	/** Schema registry for metadata endpoints */
	schemaRegistry?: SchemaRegistry;
}

/** Default system actor for REST requests */
const REST_ACTOR = {
	type: "human" as const,
	id: "rest_user",
	groups: ["admin"],
};

/**
 * Determine HTTP status code from action result.
 * Maps error patterns to appropriate status codes per spec 33.
 */
function resolveStatusCode(result: { success: boolean; data?: unknown }): number {
	if (result.success) return 200;

	const errData = result.data as Record<string, unknown> | undefined;
	const errorMsg = (errData?.error as string) ?? "";

	// Not found patterns
	if (errorMsg.includes("not found")) return 404;
	// Permission denied patterns
	if (errorMsg.includes("not allowed") || errorMsg.includes("does not belong to")) return 403;
	// Exposure blocked
	if (errorMsg.includes("not exposed")) return 403;
	// Validation failures
	if (errorMsg.includes("validation failed") || errorMsg.includes("Validation failed")) return 400;
	// State transition conflicts
	if (errorMsg.includes("State transition") || errorMsg.includes("State machine")) return 409;

	// Default: 422 for business logic failures
	return 422;
}

/**
 * Create an Elysia server with GraphQL, health check, and REST action endpoints.
 *
 * @param graphqlSchema - A GraphQL schema built via buildGraphQLSchema()
 * @param options - Server configuration
 */
export function createServer(
	graphqlSchema: GraphQLSchema,
	options?: ServerOptions,
// biome-ignore lint/suspicious/noExplicitAny: Elysia plugin chaining produces complex inferred types
): any {
	const graphqlPath = options?.graphqlPath ?? "/graphql";
	const executor = options?.executor;
	const commandLayer = options?.commandLayer;
	const executionLogger = options?.executionLogger;
	const schemaRegistry = options?.schemaRegistry;

	// Create graphql-yoga instance
	const yoga = createYoga({
		schema: graphqlSchema,
		graphqlEndpoint: graphqlPath,
		// Landing page serves as GraphQL playground in development
		landingPage: true,
	});

	const app = new Elysia()
		.use(cors())
		// Health check
		.get("/health", () => ({
			status: "ok",
			timestamp: new Date().toISOString(),
			version: "0.0.1",
		}))
		// Schema metadata endpoints
		.get("/api/schemas", () => {
			if (!schemaRegistry) {
				return { success: true, data: [] };
			}
			const schemas = schemaRegistry.getAll().map((s) => ({
				name: s.name,
				label: s.label,
				description: s.description,
				fields: s.fields,
				presentation: s.presentation,
			}));
			return { success: true, data: schemas };
		})
		.get("/api/schemas/:name", ({ params, set }) => {
			if (!schemaRegistry) {
				set.status = 404;
				return { success: false, error: { message: "Schema registry not configured." } };
			}
			const schema = schemaRegistry.get(params.name);
			if (!schema) {
				set.status = 404;
				return { success: false, error: { message: `Schema "${params.name}" not found.` } };
			}
			return { success: true, data: schema };
		})
		// REST action endpoint — executes via ActionExecutor
		// Body is unwrapped action input (Stripe-style, see spec 16 §2.4)
		.post("/api/actions/:name", async ({ params, body, set, request }) => {
			if (!executor && !commandLayer) {
				set.status = 500;
				return {
					success: false,
					error: {
						code: "SYSTEM.SERVER.NOT_CONFIGURED",
						type: "system",
						message: "Action executor not configured.",
					},
				};
			}

			const input = (body as Record<string, unknown>) ?? {};

			// Use CommandLayer pipeline when available, otherwise direct executor
			let result;
			if (commandLayer) {
				// Extract headers for middleware use
				const headers: Record<string, string> = {};
				for (const [key, value] of request.headers.entries()) {
					headers[key] = value;
				}
				result = await commandLayer.execute({
					command: params.name,
					input,
					channel: "http",
					headers,
				});
			} else {
				result = await executor!.execute(
					params.name,
					input,
					REST_ACTOR,
					{ channel: "http" },
				);
			}

			if (result.success) {
				return {
					success: true,
					data: result.data,
					meta: { executionId: result.executionId },
				};
			}

			set.status = resolveStatusCode(result);
			const errData = result.data as Record<string, unknown> | undefined;
			return {
				success: false,
				error: {
					code: "ACTION.EXECUTION.FAILED",
					message: (errData?.error as string) ?? "Action execution failed",
					...(errData?.details ? { details: errData.details } : {}),
				},
				meta: { executionId: result.executionId },
			};
		})
		// ── Execution Log REST endpoints ────────────────────────
		.get("/api/executions", ({ query, set }) => {
			if (!executionLogger) {
				set.status = 500;
				return { success: false, error: { message: "Execution logger not configured." } };
			}
			const result = executionLogger.findMany({
				action: query.action as string | undefined,
				schema: query.schema as string | undefined,
				status: query.status as ExecutionStatus | undefined,
				actorId: query.actorId as string | undefined,
				since: query.since as string | undefined,
				until: query.until as string | undefined,
				page: query.page ? Number(query.page) : undefined,
				pageSize: query.pageSize ? Number(query.pageSize) : undefined,
				sortField: query.sortField as "startedAt" | "duration" | "action" | undefined,
				sortOrder: query.sortOrder as "asc" | "desc" | undefined,
			});
			return { success: true, data: result };
		})
		.get("/api/executions/:id", ({ params, set }) => {
			if (!executionLogger) {
				set.status = 500;
				return { success: false, error: { message: "Execution logger not configured." } };
			}
			const entry = executionLogger.getById(params.id);
			if (!entry) {
				set.status = 404;
				return { success: false, error: { message: `Execution ${params.id} not found.` } };
			}
			return { success: true, data: entry };
		})
		// Mount graphql-yoga — handle all methods on the graphql path
		.all(graphqlPath, async ({ request }) => {
			const response = await yoga.handle(request);
			return response;
		});

	return app;
}
