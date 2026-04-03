/**
 * MCP Client Registry GraphQL extension
 *
 * Provides GraphQL type definitions and resolvers for MCP client management.
 * Returns field configs that can be merged into the main GraphQL schema's
 * Query and Mutation types via graphqlExtensions.
 */

import type { GraphQLFieldConfig } from "graphql";
import {
	GraphQLBoolean,
	GraphQLEnumType,
	GraphQLID,
	GraphQLInputObjectType,
	GraphQLInt,
	GraphQLList,
	GraphQLNonNull,
	GraphQLObjectType,
	GraphQLString,
} from "graphql";
import type { McpClientRegistry } from "./client-registry";

// ── Enum types ─────────────────────────────────────────────

const McpActorTypeEnum = new GraphQLEnumType({
	name: "McpActorType",
	values: {
		ai: { value: "ai" },
		service: { value: "service" },
	},
});

const ToolPolicyModeEnum = new GraphQLEnumType({
	name: "ToolPolicyMode",
	values: {
		allow_all: { value: "allow_all" },
		allowlist: { value: "allowlist" },
		denylist: { value: "denylist" },
	},
});

// ── Output types ───────────────────────────────────────────

const ToolCategoriesType = new GraphQLObjectType({
	name: "ToolCategories",
	fields: {
		introspection: { type: GraphQLBoolean },
		query: { type: GraphQLBoolean },
		actions: { type: GraphQLBoolean },
		ai_security: { type: GraphQLBoolean },
		scaffold: { type: GraphQLBoolean },
		ontology: { type: GraphQLBoolean },
		docs: { type: GraphQLBoolean },
		management: { type: GraphQLBoolean },
	},
});

const ToolPolicyType = new GraphQLObjectType({
	name: "ToolPolicy",
	fields: {
		mode: { type: new GraphQLNonNull(ToolPolicyModeEnum) },
		tools: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
		categories: { type: ToolCategoriesType },
	},
});

const McpClientType = new GraphQLObjectType({
	name: "McpClient",
	fields: {
		id: { type: new GraphQLNonNull(GraphQLID) },
		name: { type: new GraphQLNonNull(GraphQLString) },
		description: { type: GraphQLString },
		clientId: { type: new GraphQLNonNull(GraphQLString) },
		actorType: { type: new GraphQLNonNull(McpActorTypeEnum) },
		actorId: { type: new GraphQLNonNull(GraphQLString) },
		actorName: { type: new GraphQLNonNull(GraphQLString) },
		actorGroups: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
		},
		toolPolicy: { type: new GraphQLNonNull(ToolPolicyType) },
		enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
		expiresAt: { type: GraphQLString },
		lastUsedAt: { type: GraphQLString },
		createdAt: { type: new GraphQLNonNull(GraphQLString) },
		updatedAt: { type: new GraphQLNonNull(GraphQLString) },
	},
});

const McpClientCredentialsType = new GraphQLObjectType({
	name: "McpClientCredentials",
	fields: {
		clientId: { type: new GraphQLNonNull(GraphQLString) },
		clientSecret: { type: new GraphQLNonNull(GraphQLString) },
	},
});

const ToolUsageType = new GraphQLObjectType({
	name: "ToolUsage",
	fields: {
		toolName: { type: new GraphQLNonNull(GraphQLString) },
		count: { type: new GraphQLNonNull(GraphQLInt) },
	},
});

const McpUsageStatsType = new GraphQLObjectType({
	name: "McpUsageStats",
	fields: {
		clientId: { type: new GraphQLNonNull(GraphQLString) },
		totalRequests: { type: new GraphQLNonNull(GraphQLInt) },
		last24h: { type: new GraphQLNonNull(GraphQLInt) },
		last7d: { type: new GraphQLNonNull(GraphQLInt) },
		topTools: {
			type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ToolUsageType))),
		},
	},
});

// ── Input types ────────────────────────────────────────────

const ToolCategoriesInputType = new GraphQLInputObjectType({
	name: "ToolCategoriesInput",
	fields: {
		introspection: { type: GraphQLBoolean },
		query: { type: GraphQLBoolean },
		actions: { type: GraphQLBoolean },
		ai_security: { type: GraphQLBoolean },
		scaffold: { type: GraphQLBoolean },
		ontology: { type: GraphQLBoolean },
		docs: { type: GraphQLBoolean },
		management: { type: GraphQLBoolean },
	},
});

const ToolPolicyInputType = new GraphQLInputObjectType({
	name: "ToolPolicyInput",
	fields: {
		mode: { type: new GraphQLNonNull(ToolPolicyModeEnum) },
		tools: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
		categories: { type: ToolCategoriesInputType },
	},
});

const CreateMcpClientInputType = new GraphQLInputObjectType({
	name: "CreateMcpClientInput",
	fields: {
		name: { type: new GraphQLNonNull(GraphQLString) },
		description: { type: GraphQLString },
		clientId: { type: new GraphQLNonNull(GraphQLString) },
		actorType: { type: McpActorTypeEnum },
		actorId: { type: GraphQLString },
		actorName: { type: GraphQLString },
		actorGroups: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
		toolPolicy: { type: ToolPolicyInputType },
		expiresAt: { type: GraphQLString },
	},
});

const UpdateMcpClientInputType = new GraphQLInputObjectType({
	name: "UpdateMcpClientInput",
	fields: {
		name: { type: GraphQLString },
		description: { type: GraphQLString },
		actorType: { type: McpActorTypeEnum },
		actorId: { type: GraphQLString },
		actorName: { type: GraphQLString },
		actorGroups: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
		toolPolicy: { type: ToolPolicyInputType },
		enabled: { type: GraphQLBoolean },
		expiresAt: { type: GraphQLString },
	},
});

// ── Serialization helpers ──────────────────────────────────

/** Serialize McpClient for GraphQL response (dates to ISO, no secretHash) */
function serializeClient(client: {
	id: string;
	name: string;
	description?: string;
	clientId: string;
	actorType: string;
	actorId: string;
	actorName: string;
	actorGroups: string[];
	toolPolicy: { mode: string; tools: string[]; categories?: Record<string, boolean> };
	enabled: boolean;
	expiresAt?: Date;
	lastUsedAt?: Date;
	createdAt: Date;
	updatedAt: Date;
}): Record<string, unknown> {
	return {
		id: client.id,
		name: client.name,
		description: client.description ?? null,
		clientId: client.clientId,
		actorType: client.actorType,
		actorId: client.actorId,
		actorName: client.actorName,
		actorGroups: client.actorGroups,
		toolPolicy: client.toolPolicy,
		enabled: client.enabled,
		expiresAt: client.expiresAt?.toISOString() ?? null,
		lastUsedAt: client.lastUsedAt?.toISOString() ?? null,
		createdAt: client.createdAt.toISOString(),
		updatedAt: client.updatedAt.toISOString(),
	};
}

// ── Extension builder ──────────────────────────────────────

export interface McpGraphQLExtensionOptions {
	registry: McpClientRegistry;
}

export interface McpGraphQLExtension {
	queryFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
	mutationFields: Record<string, GraphQLFieldConfig<unknown, unknown>>;
}

/**
 * Build the GraphQL extension for MCP client registry.
 *
 * Returns query and mutation fields for managing MCP clients.
 */
export function buildMcpGraphQLExtension(
	options: McpGraphQLExtensionOptions,
): McpGraphQLExtension {
	const { registry } = options;

	// ── Query fields ─────────────────────────────────────

	const mcpClients: GraphQLFieldConfig<unknown, unknown> = {
		type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(McpClientType))),
		description: "List registered MCP clients",
		args: {
			enabled: { type: GraphQLBoolean, description: "Filter by enabled status" },
		},
		resolve: async (_source: unknown, args: { enabled?: boolean }) => {
			const filter = args.enabled !== undefined ? { enabled: args.enabled } : undefined;
			const clients = await registry.listClients(filter);
			return clients.map(serializeClient);
		},
	};

	const mcpClient: GraphQLFieldConfig<unknown, unknown> = {
		type: McpClientType,
		description: "Get a single MCP client by ID",
		args: {
			id: { type: new GraphQLNonNull(GraphQLID) },
		},
		resolve: async (_source: unknown, args: { id: string }) => {
			const client = await registry.getClient(args.id);
			return client ? serializeClient(client) : null;
		},
	};

	const mcpUsageStats: GraphQLFieldConfig<unknown, unknown> = {
		type: McpUsageStatsType,
		description: "Get usage statistics for an MCP client (stub — returns mock data)",
		args: {
			id: { type: new GraphQLNonNull(GraphQLID) },
		},
		resolve: async (_source: unknown, args: { id: string }) => {
			const client = await registry.getClient(args.id);
			if (!client) return null;
			// Stub implementation — return mock data
			return {
				clientId: client.clientId,
				totalRequests: 0,
				last24h: 0,
				last7d: 0,
				topTools: [],
			};
		},
	};

	// ── Mutation fields ──────────────────────────────────

	const createMcpClient: GraphQLFieldConfig<unknown, unknown> = {
		type: new GraphQLNonNull(McpClientCredentialsType),
		description: "Create a new MCP client. Returns credentials (secret shown only once).",
		args: {
			input: { type: new GraphQLNonNull(CreateMcpClientInputType) },
		},
		resolve: async (
			_source: unknown,
			args: {
				input: {
					name: string;
					clientId: string;
					description?: string;
					actorType?: "ai" | "service";
					actorId?: string;
					actorName?: string;
					actorGroups?: string[];
					toolPolicy?: { mode: "allow_all" | "allowlist" | "denylist"; tools: string[]; categories?: Record<string, boolean> };
					expiresAt?: string;
				};
			},
		) => {
			const input = {
				...args.input,
				expiresAt: args.input.expiresAt ? new Date(args.input.expiresAt) : undefined,
			};
			const { client, secret } = await registry.createClient(input);
			return {
				clientId: client.clientId,
				clientSecret: secret,
			};
		},
	};

	const updateMcpClient: GraphQLFieldConfig<unknown, unknown> = {
		type: new GraphQLNonNull(McpClientType),
		description: "Update an existing MCP client",
		args: {
			id: { type: new GraphQLNonNull(GraphQLID) },
			input: { type: new GraphQLNonNull(UpdateMcpClientInputType) },
		},
		resolve: async (
			_source: unknown,
			args: {
				id: string;
				input: {
					name?: string;
					description?: string;
					actorType?: "ai" | "service";
					actorId?: string;
					actorName?: string;
					actorGroups?: string[];
					toolPolicy?: { mode: "allow_all" | "allowlist" | "denylist"; tools: string[]; categories?: Record<string, boolean> };
					enabled?: boolean;
					expiresAt?: string;
				};
			},
		) => {
			const input = {
				...args.input,
				expiresAt: args.input.expiresAt ? new Date(args.input.expiresAt) : undefined,
			};
			const client = await registry.updateClient(args.id, input);
			return serializeClient(client);
		},
	};

	const deleteMcpClient: GraphQLFieldConfig<unknown, unknown> = {
		type: new GraphQLNonNull(GraphQLBoolean),
		description: "Delete an MCP client",
		args: {
			id: { type: new GraphQLNonNull(GraphQLID) },
		},
		resolve: async (_source: unknown, args: { id: string }) => {
			await registry.deleteClient(args.id);
			return true;
		},
	};

	const rotateMcpClientSecret: GraphQLFieldConfig<unknown, unknown> = {
		type: new GraphQLNonNull(McpClientCredentialsType),
		description: "Rotate an MCP client's secret. Returns new credentials.",
		args: {
			id: { type: new GraphQLNonNull(GraphQLID) },
		},
		resolve: async (_source: unknown, args: { id: string }) => {
			const { clientId, secret } = await registry.rotateSecret(args.id);
			return {
				clientId,
				clientSecret: secret,
			};
		},
	};

	const toggleMcpClient: GraphQLFieldConfig<unknown, unknown> = {
		type: new GraphQLNonNull(McpClientType),
		description: "Enable or disable an MCP client",
		args: {
			id: { type: new GraphQLNonNull(GraphQLID) },
			enabled: { type: new GraphQLNonNull(GraphQLBoolean) },
		},
		resolve: async (_source: unknown, args: { id: string; enabled: boolean }) => {
			const client = await registry.toggleClient(args.id, args.enabled);
			return serializeClient(client);
		},
	};

	return {
		queryFields: {
			mcpClients,
			mcpClient,
			mcpUsageStats,
		},
		mutationFields: {
			createMcpClient,
			updateMcpClient,
			deleteMcpClient,
			rotateMcpClientSecret,
			toggleMcpClient,
		},
	};
}
