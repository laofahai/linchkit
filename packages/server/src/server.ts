/**
 * Main HTTP server setup — Elysia + graphql-yoga
 *
 * Provides a ready-to-use server with:
 * - CORS support
 * - GraphQL endpoint (via graphql-yoga)
 * - Health check endpoint
 * - REST action stub endpoint
 */

import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { createYoga } from "graphql-yoga";
import type { GraphQLSchema } from "graphql";

export interface ServerOptions {
	/** Server port (default: 3001) */
	port?: number;
	/** GraphQL endpoint path (default: "/graphql") */
	graphqlPath?: string;
}

/**
 * Create an Elysia server with GraphQL, health check, and action stub endpoints.
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
		// REST action stub (Command Layer placeholder)
		.post("/api/v1/actions/:name", ({ params, body }) => ({
			success: false,
			error: {
				code: "NOT_IMPLEMENTED",
				message: `Action '${params.name}' execution via REST is not yet implemented. Use GraphQL mutations or wait for the Command Layer.`,
			},
			meta: {
				action: params.name,
				input: body,
			},
		}))
		// Mount graphql-yoga — handle all methods on the graphql path
		.all(graphqlPath, async ({ request }) => {
			const response = await yoga.handle(request);
			return response;
		});

	return app;
}
