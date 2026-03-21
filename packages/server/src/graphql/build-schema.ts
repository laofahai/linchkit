/**
 * Build a complete GraphQL schema from LinchKit SchemaDefinitions.
 *
 * Generates Query and Mutation types wired to the Action Engine
 * and an in-memory DataProvider. Includes CRUD mutations for each
 * schema plus a generic executeAction mutation.
 */

import {
	GraphQLBoolean,
	GraphQLID,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
} from "graphql";
import type {
	ActionDefinition,
	ActionExecutor,
	SchemaDefinition,
} from "@linchkit/core";
import {
	generateGraphQLObjectType,
	generateGraphQLInputType,
} from "./schema-to-graphql";
import type { InMemoryStore } from "../data/in-memory-store";

/**
 * Convert a schema name to PascalCase.
 * e.g. "purchase_request" -> "PurchaseRequest"
 */
function toPascalCase(name: string): string {
	return name
		.split(/[_-]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * Convert a schema name to camelCase.
 * e.g. "purchase_request" -> "purchaseRequest"
 */
function toCamelCase(name: string): string {
	const pascal = toPascalCase(name);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Default system actor for GraphQL requests */
const GRAPHQL_ACTOR = {
	type: "human" as const,
	id: "graphql_user",
	roles: ["admin"],
};

// ── ActionResult GraphQL type ──────────────────────────────

const ActionErrorType = new GraphQLObjectType({
	name: "ActionError",
	fields: {
		code: { type: new GraphQLNonNull(GraphQLString) },
		message: { type: new GraphQLNonNull(GraphQLString) },
	},
});

const ActionResultType = new GraphQLObjectType({
	name: "ActionResult",
	fields: {
		success: { type: new GraphQLNonNull(GraphQLBoolean) },
		data: { type: GraphQLString, description: "JSON-encoded result data" },
		errors: { type: new GraphQLList(new GraphQLNonNull(ActionErrorType)) },
		executionId: { type: GraphQLString },
	},
});

// ── Default CRUD action definitions ─────────────────────────

/**
 * Generate default CRUD action definitions for a schema.
 */
export function generateCrudActions(
	schema: SchemaDefinition,
): ActionDefinition[] {
	const name = schema.name;

	const createAction: ActionDefinition = {
		name: `create_${name}`,
		schema: name,
		label: `Create ${schema.label ?? name}`,
		description: `Create a new ${schema.label ?? name} record`,
		policy: { mode: "sync", transaction: false },
		exposure: "all",
		handler: async (ctx) => {
			return ctx.create(name, ctx.input);
		},
	};

	const updateAction: ActionDefinition = {
		name: `update_${name}`,
		schema: name,
		label: `Update ${schema.label ?? name}`,
		description: `Update an existing ${schema.label ?? name} record`,
		policy: { mode: "sync", transaction: false },
		exposure: "all",
		handler: async (ctx) => {
			const id = ctx.input.id as string;
			const { id: _id, ...data } = ctx.input;
			return ctx.update(name, id, data);
		},
	};

	const deleteAction: ActionDefinition = {
		name: `delete_${name}`,
		schema: name,
		label: `Delete ${schema.label ?? name}`,
		description: `Delete a ${schema.label ?? name} record`,
		policy: { mode: "sync", transaction: false },
		exposure: "all",
		handler: async (ctx) => {
			const id = ctx.input.id as string;
			await ctx.delete(name, id);
			return { deleted: true, id };
		},
	};

	return [createAction, updateAction, deleteAction];
}

// ── Schema builder options ──────────────────────────────────

export interface BuildGraphQLSchemaOptions {
	/** Action executor for wiring mutations */
	executor?: ActionExecutor;
	/** In-memory store for query resolvers */
	store?: InMemoryStore;
}

/**
 * Build a complete GraphQL schema from an array of SchemaDefinitions.
 *
 * For each schema, generates:
 * - Query: `{camelName}(id: ID!): Type` and `{camelName}List: [Type!]!`
 * - Mutation: `create{PascalName}`, `update{PascalName}`, `delete{PascalName}`
 *
 * When executor/store are provided, resolvers are wired to actual data.
 * Otherwise falls back to stub/mock resolvers for backward compatibility.
 */
export function buildGraphQLSchema(
	schemas: SchemaDefinition[],
	options?: BuildGraphQLSchemaOptions,
): GraphQLSchema {
	const executor = options?.executor;
	const store = options?.store;

	if (schemas.length === 0) {
		// Return a minimal valid schema with a placeholder query
		return new GraphQLSchema({
			query: new GraphQLObjectType({
				name: "Query",
				fields: {
					_empty: {
						type: GraphQLString,
						resolve: () => "No schemas registered",
					},
				},
			}),
		});
	}

	const queryFields: Record<string, unknown> = {};
	const mutationFields: Record<string, unknown> = {};

	for (const schema of schemas) {
		const objectType = generateGraphQLObjectType(schema);
		const inputType = generateGraphQLInputType(schema);
		const camelName = toCamelCase(schema.name);
		const pascalName = toPascalCase(schema.name);
		const schemaName = schema.name;

		// Build a mock record for fallback stub resolvers
		const mockRecord = buildMockRecord(schema);

		// ── Query: get by ID ──────────────────────────────────
		queryFields[camelName] = {
			type: objectType,
			args: {
				id: { type: new GraphQLNonNull(GraphQLID) },
			},
			resolve: store
				? async (_root: unknown, args: { id: string }) => {
						try {
							return await store.get(schemaName, args.id);
						} catch {
							return null;
						}
					}
				: (_root: unknown, args: { id: string }) => ({
						...mockRecord,
						id: args.id,
					}),
		};

		// ── Query: list with filter/sort/pagination ───────────
		queryFields[`${camelName}List`] = {
			type: new GraphQLNonNull(
				new GraphQLList(new GraphQLNonNull(objectType)),
			),
			args: {
				filter: {
					type: GraphQLString,
					description: "JSON-encoded filter object",
				},
				sortField: { type: GraphQLString, description: "Field to sort by" },
				sortOrder: {
					type: GraphQLString,
					description: "Sort order: asc or desc",
				},
				offset: { type: GraphQLInt, description: "Pagination offset" },
				limit: { type: GraphQLInt, description: "Pagination limit" },
			},
			resolve: store
				? (
						_root: unknown,
						args: {
							filter?: string;
							sortField?: string;
							sortOrder?: string;
							offset?: number;
							limit?: number;
						},
					) => {
						const filter = args.filter
							? JSON.parse(args.filter)
							: undefined;
						const sort =
							args.sortField
								? {
										field: args.sortField,
										order: (args.sortOrder as "asc" | "desc") ?? "asc",
									}
								: undefined;
						return store.findMany(schemaName, {
							filter,
							sort,
							offset: args.offset ?? undefined,
							limit: args.limit ?? undefined,
						});
					}
				: () => [],
		};

		// ── Mutation: create ──────────────────────────────────
		mutationFields[`create${pascalName}`] = {
			type: objectType,
			args: {
				input: { type: new GraphQLNonNull(inputType) },
			},
			resolve: executor
				? async (
						_root: unknown,
						args: { input: Record<string, unknown> },
					) => {
						const result = await executor.execute(
							`create_${schemaName}`,
							args.input,
							GRAPHQL_ACTOR,
							{ channel: "http" },
						);
						if (!result.success) {
							const errData = result.data as
								| Record<string, unknown>
								| undefined;
							throw new Error(
								(errData?.error as string) ??
									"Create action failed",
							);
						}
						return result.data;
					}
				: (
						_root: unknown,
						args: { input: Record<string, unknown> },
					) => ({
						...mockRecord,
						...args.input,
						id: `mock_${Date.now()}`,
					}),
		};

		// ── Mutation: update ──────────────────────────────────
		mutationFields[`update${pascalName}`] = {
			type: objectType,
			args: {
				id: { type: new GraphQLNonNull(GraphQLID) },
				input: { type: new GraphQLNonNull(inputType) },
			},
			resolve: executor
				? async (
						_root: unknown,
						args: { id: string; input: Record<string, unknown> },
					) => {
						const result = await executor.execute(
							`update_${schemaName}`,
							{ id: args.id, ...args.input },
							GRAPHQL_ACTOR,
							{ channel: "http" },
						);
						if (!result.success) {
							const errData = result.data as
								| Record<string, unknown>
								| undefined;
							throw new Error(
								(errData?.error as string) ??
									"Update action failed",
							);
						}
						return result.data;
					}
				: (
						_root: unknown,
						args: { id: string; input: Record<string, unknown> },
					) => ({
						...mockRecord,
						...args.input,
						id: args.id,
						updated_at: new Date().toISOString(),
					}),
		};

		// ── Mutation: delete ──────────────────────────────────
		mutationFields[`delete${pascalName}`] = {
			type: GraphQLBoolean,
			args: {
				id: { type: new GraphQLNonNull(GraphQLID) },
			},
			resolve: executor
				? async (_root: unknown, args: { id: string }) => {
						const result = await executor.execute(
							`delete_${schemaName}`,
							{ id: args.id },
							GRAPHQL_ACTOR,
							{ channel: "http" },
						);
						return result.success;
					}
				: () => true,
		};
	}

	// ── Generic executeAction mutation ────────────────────────
	mutationFields.executeAction = {
		type: ActionResultType,
		args: {
			name: { type: new GraphQLNonNull(GraphQLString) },
			input: {
				type: new GraphQLNonNull(GraphQLString),
				description: "JSON-encoded input object",
			},
		},
		resolve: executor
			? async (
					_root: unknown,
					args: { name: string; input: string },
				) => {
					const input = JSON.parse(args.input);
					const result = await executor.execute(
						args.name,
						input,
						GRAPHQL_ACTOR,
						{ channel: "http" },
					);
					const errors = !result.success
						? [
								{
									code: "ACTION_FAILED",
									message:
										(
											result.data as
												| Record<string, unknown>
												| undefined
										)?.error ?? "Action execution failed",
								},
							]
						: null;
					return {
						success: result.success,
						data: result.data
							? JSON.stringify(result.data)
							: null,
						errors,
						executionId: result.executionId,
					};
				}
			: (
					_root: unknown,
					args: { name: string; input: string },
				) => ({
					success: false,
					data: null,
					errors: [
						{
							code: "NOT_WIRED",
							message: `Action executor not configured. Cannot execute "${args.name}".`,
						},
					],
					executionId: null,
				}),
	};

	// biome-ignore lint/suspicious/noExplicitAny: GraphQL field config types are complex
	const query = new GraphQLObjectType({
		name: "Query",
		fields: queryFields as any,
	});

	// biome-ignore lint/suspicious/noExplicitAny: GraphQL field config types are complex
	const mutation = new GraphQLObjectType({
		name: "Mutation",
		fields: mutationFields as any,
	});

	return new GraphQLSchema({ query, mutation });
}

/**
 * Build a mock record with system fields and default values.
 */
function buildMockRecord(
	schema: SchemaDefinition,
): Record<string, unknown> {
	const now = new Date().toISOString();
	const record: Record<string, unknown> = {
		id: "mock_id",
		tenant_id: null,
		created_at: now,
		updated_at: now,
		created_by: null,
		updated_by: null,
		_version: 1,
	};

	// Set default values for user-defined fields
	for (const [fieldName, field] of Object.entries(schema.fields)) {
		if (field.default !== undefined) {
			record[fieldName] = field.default;
		} else if (field.required) {
			// Provide type-appropriate defaults for required fields
			switch (field.type) {
				case "string":
				case "text":
				case "ref":
				case "state":
				case "enum":
					record[fieldName] = "";
					break;
				case "number":
					record[fieldName] = 0;
					break;
				case "boolean":
					record[fieldName] = false;
					break;
				case "date":
				case "datetime":
					record[fieldName] = now;
					break;
				default:
					record[fieldName] = "";
					break;
			}
		} else {
			record[fieldName] = null;
		}
	}

	return record;
}
