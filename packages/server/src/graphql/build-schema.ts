/**
 * Build a complete GraphQL schema from LinchKit SchemaDefinitions.
 *
 * Generates Query and Mutation types wired to the Action Engine
 * and an in-memory DataProvider. Includes CRUD mutations for each
 * schema plus a generic executeAction mutation.
 */

import type {
  ActionDefinition,
  ActionExecutor,
  ExecutionLogger,
  ExecutionStatus,
  SchemaDefinition,
} from "@linchkit/core";
import {
  GraphQLBoolean,
  type GraphQLFieldConfig,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import type { InMemoryStore } from "../data/in-memory-store";
import {
  generateActionInputType,
  generateGraphQLInputType,
  generateGraphQLObjectType,
} from "./schema-to-graphql";

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
  groups: ["admin"],
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
export function generateCrudActions(schema: SchemaDefinition): ActionDefinition[] {
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

// ── ExecutionLog GraphQL types ───────────────────────────────

const ExecutionActorType = new GraphQLObjectType({
  name: "ExecutionActor",
  fields: {
    type: { type: new GraphQLNonNull(GraphQLString) },
    id: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ExecutionRuleResultType = new GraphQLObjectType({
  name: "ExecutionRuleResult",
  fields: {
    rule: { type: new GraphQLNonNull(GraphQLString) },
    result: { type: new GraphQLNonNull(GraphQLString) },
    message: { type: GraphQLString },
  },
});

const ExecutionStateTransitionType = new GraphQLObjectType({
  name: "ExecutionStateTransition",
  fields: {
    from: { type: new GraphQLNonNull(GraphQLString) },
    to: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ExecutionErrorType = new GraphQLObjectType({
  name: "ExecutionError",
  fields: {
    code: { type: GraphQLString },
    message: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const ExecutionLogEntryType = new GraphQLObjectType({
  name: "ExecutionLogEntry",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    action: { type: new GraphQLNonNull(GraphQLString) },
    capability: { type: GraphQLString },
    schema: { type: GraphQLString },
    recordId: { type: GraphQLString },
    actor: { type: new GraphQLNonNull(ExecutionActorType) },
    input: {
      type: GraphQLString,
      description: "JSON-encoded input",
      resolve: (e: Record<string, unknown>) => JSON.stringify(e.input),
    },
    output: {
      type: GraphQLString,
      description: "JSON-encoded output",
      resolve: (e: Record<string, unknown>) => (e.output ? JSON.stringify(e.output) : null),
    },
    status: { type: new GraphQLNonNull(GraphQLString) },
    error: { type: ExecutionErrorType },
    rulesEvaluated: { type: new GraphQLList(new GraphQLNonNull(ExecutionRuleResultType)) },
    stateTransition: { type: ExecutionStateTransitionType },
    duration: { type: new GraphQLNonNull(GraphQLInt) },
    startedAt: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: (e: Record<string, unknown>) => (e.startedAt as Date).toISOString(),
    },
    completedAt: {
      type: new GraphQLNonNull(GraphQLString),
      resolve: (e: Record<string, unknown>) => (e.completedAt as Date).toISOString(),
    },
  },
});

const ExecutionLogListResultType = new GraphQLObjectType({
  name: "ExecutionLogListResult",
  fields: {
    items: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ExecutionLogEntryType))) },
    total: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

// ── Schema builder options ──────────────────────────────────

export interface BuildGraphQLSchemaOptions {
  /** Action executor for wiring mutations */
  executor?: ActionExecutor;
  /** In-memory store for query resolvers */
  store?: InMemoryStore;
  /** Custom actions to generate typed mutations for (beyond auto-generated CRUD) */
  actions?: ActionDefinition[];
  /** Execution logger for log query endpoints */
  executionLogger?: ExecutionLogger;
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
  const executionLogger = options?.executionLogger;

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

  // Pre-generate object types to reuse for both CRUD and custom action return types
  const schemaObjectTypes = new Map<string, GraphQLObjectType>();
  for (const schema of schemas) {
    schemaObjectTypes.set(schema.name, generateGraphQLObjectType(schema));
  }

  for (const schema of schemas) {
    const objectType = schemaObjectTypes.get(schema.name);
    if (!objectType) continue;
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

    // ── ListResult type for paginated responses ──────────
    const listResultType = new GraphQLObjectType({
      name: `${pascalName}ListResult`,
      fields: {
        items: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
        },
        total: { type: new GraphQLNonNull(GraphQLInt) },
      },
    });

    // ── Query: list with filter/sort/pagination ───────────
    queryFields[`${camelName}List`] = {
      type: new GraphQLNonNull(listResultType),
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
        page: { type: GraphQLInt, description: "Page number (1-based)" },
        pageSize: { type: GraphQLInt, description: "Number of items per page" },
      },
      resolve: store
        ? (
            _root: unknown,
            args: {
              filter?: string;
              sortField?: string;
              sortOrder?: string;
              page?: number;
              pageSize?: number;
            },
          ) => {
            const filter = args.filter ? JSON.parse(args.filter) : undefined;
            const sort = args.sortField
              ? {
                  field: args.sortField,
                  order: (args.sortOrder as "asc" | "desc") ?? "asc",
                }
              : undefined;
            const page = args.page ?? 1;
            const pageSize = args.pageSize ?? undefined;
            const offset = pageSize ? (page - 1) * pageSize : 0;
            const items = store.findMany(schemaName, {
              filter,
              sort,
              offset,
              limit: pageSize,
            });
            const total = store.count(schemaName, filter);
            return { items, total };
          }
        : () => ({ items: [], total: 0 }),
    };

    // ── Mutation: create ──────────────────────────────────
    mutationFields[`create${pascalName}`] = {
      type: objectType,
      args: {
        input: { type: new GraphQLNonNull(inputType) },
      },
      resolve: executor
        ? async (_root: unknown, args: { input: Record<string, unknown> }) => {
            const result = await executor.execute(
              `create_${schemaName}`,
              args.input,
              GRAPHQL_ACTOR,
              { channel: "http" },
            );
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new Error((errData?.error as string) ?? "Create action failed");
            }
            return result.data;
          }
        : (_root: unknown, args: { input: Record<string, unknown> }) => ({
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
        ? async (_root: unknown, args: { id: string; input: Record<string, unknown> }) => {
            const result = await executor.execute(
              `update_${schemaName}`,
              { id: args.id, ...args.input },
              GRAPHQL_ACTOR,
              { channel: "http" },
            );
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new Error((errData?.error as string) ?? "Update action failed");
            }
            return result.data;
          }
        : (_root: unknown, args: { id: string; input: Record<string, unknown> }) => ({
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

  // ── Execution Log queries ────────────────────────────────
  if (executionLogger) {
    queryFields.executionLogs = {
      type: new GraphQLNonNull(ExecutionLogListResultType),
      args: {
        action: { type: GraphQLString },
        schema: { type: GraphQLString },
        status: { type: GraphQLString },
        actorId: { type: GraphQLString },
        since: { type: GraphQLString },
        until: { type: GraphQLString },
        page: { type: GraphQLInt },
        pageSize: { type: GraphQLInt },
        sortField: { type: GraphQLString },
        sortOrder: { type: GraphQLString },
      },
      resolve: (
        _root: unknown,
        args: {
          action?: string;
          schema?: string;
          status?: string;
          actorId?: string;
          since?: string;
          until?: string;
          page?: number;
          pageSize?: number;
          sortField?: string;
          sortOrder?: string;
        },
      ) =>
        executionLogger.findMany({
          action: args.action,
          schema: args.schema,
          status: args.status as ExecutionStatus | undefined,
          actorId: args.actorId,
          since: args.since,
          until: args.until,
          page: args.page,
          pageSize: args.pageSize,
          sortField: args.sortField as "startedAt" | "duration" | "action" | undefined,
          sortOrder: args.sortOrder as "asc" | "desc" | undefined,
        }),
    };

    queryFields.executionLog = {
      type: ExecutionLogEntryType,
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
      },
      resolve: (_root: unknown, args: { id: string }) => executionLogger.getById(args.id) ?? null,
    };
  }

  // ── Custom action typed mutations ────────────────────────
  const customActions = options?.actions ?? [];
  for (const action of customActions) {
    const mutationName = toCamelCase(action.name);
    const actionName = action.name;
    const actionInputType = generateActionInputType(action);

    // Determine return type: schema's object type if action belongs to a schema, else ActionResult
    const returnType =
      action.schema && schemaObjectTypes.has(action.schema)
        ? (schemaObjectTypes.get(action.schema) ?? ActionResultType)
        : ActionResultType;
    const returnsSchemaType = returnType !== ActionResultType;

    // Build args: always include id (ID!), optionally include typed input
    const args: Record<string, unknown> = {
      id: { type: new GraphQLNonNull(GraphQLID) },
    };
    if (actionInputType) {
      args.input = { type: new GraphQLNonNull(actionInputType) };
    }

    mutationFields[mutationName] = {
      type: returnType,
      description: action.description ?? action.label,
      args,
      resolve: executor
        ? async (_root: unknown, resolverArgs: { id: string; input?: Record<string, unknown> }) => {
            const input: Record<string, unknown> = {
              id: resolverArgs.id,
              ...resolverArgs.input,
            };
            const result = await executor.execute(actionName, input, GRAPHQL_ACTOR, {
              channel: "http",
            });
            if (returnsSchemaType) {
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                throw new Error((errData?.error as string) ?? `Action "${actionName}" failed`);
              }
              return result.data;
            }
            // Return ActionResult shape
            const errors = !result.success
              ? [
                  {
                    code: "ACTION_FAILED",
                    message:
                      (result.data as Record<string, unknown> | undefined)?.error ??
                      "Action execution failed",
                  },
                ]
              : null;
            return {
              success: result.success,
              data: result.data ? JSON.stringify(result.data) : null,
              errors,
              executionId: result.executionId,
            };
          }
        : () => {
            if (returnsSchemaType) {
              return null;
            }
            return {
              success: false,
              data: null,
              errors: [
                {
                  code: "NOT_WIRED",
                  message: `Action executor not configured. Cannot execute "${actionName}".`,
                },
              ],
              executionId: null,
            };
          },
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
      ? async (_root: unknown, args: { name: string; input: string }) => {
          const input = JSON.parse(args.input);
          const result = await executor.execute(args.name, input, GRAPHQL_ACTOR, {
            channel: "http",
          });
          const errors = !result.success
            ? [
                {
                  code: "ACTION_FAILED",
                  message:
                    (result.data as Record<string, unknown> | undefined)?.error ??
                    "Action execution failed",
                },
              ]
            : null;
          return {
            success: result.success,
            data: result.data ? JSON.stringify(result.data) : null,
            errors,
            executionId: result.executionId,
          };
        }
      : (_root: unknown, args: { name: string; input: string }) => ({
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

  const query = new GraphQLObjectType({
    name: "Query",
    fields: queryFields as Record<string, GraphQLFieldConfig<unknown, unknown>>,
  });

  const mutation = new GraphQLObjectType({
    name: "Mutation",
    fields: mutationFields as Record<string, GraphQLFieldConfig<unknown, unknown>>,
  });

  return new GraphQLSchema({ query, mutation });
}

/**
 * Build a mock record with system fields and default values.
 */
function buildMockRecord(schema: SchemaDefinition): Record<string, unknown> {
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
