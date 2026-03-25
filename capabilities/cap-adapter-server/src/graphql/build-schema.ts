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
  Actor,
  DataProvider,
  DataQueryOptions,
  EventBus,
  ExecutionLogger,
  ExecutionStatus,
  LinkDefinition,
  MaskRecordOptions,
  PermissionGroupDefinition,
  SchemaDefinition,
} from "@linchkit/core";
import type { DerivedPropertyEngine } from "@linchkit/core";
import { resolveTranslatableRow } from "@linchkit/core";
import { maskRecord, maskRecords } from "@linchkit/core/server";
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLFieldConfig,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from "graphql";
import { buildSubscriptionFields, createEventBusPubSub } from "./build-subscriptions";
import {
  generateActionInputType,
  generateGraphQLInputType,
  generateGraphQLObjectType,
} from "./schema-to-graphql";

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * Convert a schema name to PascalCase with GraphQL name sanitization.
 * e.g. "purchase_request" -> "PurchaseRequest"
 */
function toPascalCase(name: string): string {
  const raw = name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  // Strip characters not allowed in GraphQL names
  const sanitized = raw.replace(/[^_0-9A-Za-z]/g, "");

  // Ensure name starts with a letter or underscore
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

/**
 * Convert a schema name to camelCase.
 * e.g. "purchase_request" -> "purchaseRequest"
 */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** GraphQL resolver context — carries actor, tenant isolation, locale, and data access */
export interface GraphQLContext {
  /** Authenticated actor resolved from the request; falls back to ANONYMOUS_ACTOR */
  actor: Actor;
  /** Tenant ID resolved from the authenticated user; undefined means no tenant filtering */
  tenantId?: string;
  /** Locale for resolving translatable fields (e.g., "zh-CN", "en") */
  locale?: string;
  /** Data provider for link relation resolvers */
  dataProvider?: DataProvider;
  /** Permission groups for data masking unmask checks */
  permissionGroups?: PermissionGroupDefinition[];
  /** Schema definitions map for link resolver data masking */
  schemaMap?: Map<string, SchemaDefinition>;
}

/** Maximum page size for list queries */
const MAX_PAGE_SIZE = 100;

/** Maximum allowed length for JSON string arguments */
const MAX_JSON_LENGTH = 10_000;

/**
 * Safely parse a JSON string argument with size validation.
 * Throws a GraphQLError on invalid input.
 */
function safeParseJSON(value: string, argName: string): Record<string, unknown> {
  if (value.length > MAX_JSON_LENGTH) {
    throw new GraphQLError(
      `Argument "${argName}" exceeds maximum allowed length of ${MAX_JSON_LENGTH} characters`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GraphQLError(`Argument "${argName}" contains invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GraphQLError(`Argument "${argName}" must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

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

/** Options for CRUD action generation */
export interface GenerateCrudActionsOptions {
  /** Derived property engine for auto-computing store-strategy derived fields */
  derivedPropertyEngine?: DerivedPropertyEngine;
}

/**
 * Generate default CRUD action definitions for a schema.
 */
export function generateCrudActions(
  schema: SchemaDefinition,
  options?: GenerateCrudActionsOptions,
): ActionDefinition[] {
  const name = schema.name;
  const derivedEngine = options?.derivedPropertyEngine;

  const createAction: ActionDefinition = {
    name: `create_${name}`,
    schema: name,
    label: `Create ${schema.label ?? name}`,
    description: `Create a new ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      // Inject default state values for state fields not provided in input
      const inputWithDefaults = { ...ctx.input };
      for (const [fieldName, field] of Object.entries(schema.fields)) {
        if (field.type === "state" && inputWithDefaults[fieldName] === undefined) {
          if (field.default !== undefined) {
            inputWithDefaults[fieldName] = field.default;
          }
        }
      }
      // Compute store-strategy derived fields before persisting
      if (derivedEngine) {
        try {
          const derivedValues = derivedEngine.computeStoreFields(name, inputWithDefaults);
          Object.assign(inputWithDefaults, derivedValues);
        } catch (err) {
          throw new Error(`Derived field computation failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return ctx.create(name, inputWithDefaults);
    },
  };

  const updateAction: ActionDefinition = {
    name: `update_${name}`,
    schema: name,
    label: `Update ${schema.label ?? name}`,
    description: `Update an existing ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const id = ctx.input.id as string;
      const { id: _id, ...data } = ctx.input;
      // Compute store-strategy derived fields before persisting.
      // Merge existing record with new data so derived expressions can access all fields.
      if (derivedEngine) {
        let fullRecord: Record<string, unknown>;
        try {
          const existing = await ctx.get(name, id);
          fullRecord = { ...existing, ...data };
        } catch (err) {
          // Only fall back for NotFoundError; re-throw unexpected errors
          if (err instanceof Error && err.message.includes("not found")) {
            fullRecord = { ...data };
          } else {
            throw err;
          }
        }
        try {
          const derivedValues = derivedEngine.computeStoreFields(name, fullRecord);
          Object.assign(data, derivedValues);
        } catch (err) {
          throw new Error(`Derived field computation failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return ctx.update(name, id, data);
    },
  };

  const deleteAction: ActionDefinition = {
    name: `delete_${name}`,
    schema: name,
    label: `Delete ${schema.label ?? name}`,
    description: `Delete a ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
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
      type: GraphQLString,
      resolve: (e: Record<string, unknown>) =>
        e.completedAt ? (e.completedAt as Date).toISOString() : null,
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
  /** Data provider for query resolvers (get, query, count) */
  dataProvider?: DataProvider;
  /** Custom actions to generate typed mutations for (beyond auto-generated CRUD) */
  actions?: ActionDefinition[];
  /** Execution logger for log query endpoints */
  executionLogger?: ExecutionLogger;
  /** Link definitions for generating bidirectional relation resolver fields */
  links?: LinkDefinition[];
  /** Event bus for wiring GraphQL subscriptions (real-time CRUD events via SSE) */
  eventBus?: EventBus;
  /** Permission groups for data masking (unmask permission checks) */
  permissionGroups?: PermissionGroupDefinition[];
  /** Derived property engine for auto-computing derived fields on read and write */
  derivedPropertyEngine?: DerivedPropertyEngine;
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
  const dataProvider = options?.dataProvider;
  const executionLogger = options?.executionLogger;
  const links = options?.links ?? [];
  const eventBus = options?.eventBus;
  const permissionGroups = options?.permissionGroups ?? [];
  const derivedEngine = options?.derivedPropertyEngine;

  // Build schema lookup map for data masking
  const schemaMap = new Map<string, SchemaDefinition>();
  for (const s of schemas) {
    schemaMap.set(s.name, s);
  }

  /** Field types whose masked values cannot be represented as strings in GraphQL (must become null) */
  const NON_STRING_FIELD_TYPES = new Set(["number", "boolean", "date", "datetime", "json"]);

  /** Apply data masking to a record based on actor permissions */
  const applyMasking = (
    record: Record<string, unknown>,
    schemaName: string,
    ctx: GraphQLContext,
  ): Record<string, unknown> => {
    const schemaDef = schemaMap.get(schemaName);
    if (!schemaDef) return record;
    const maskOpts: MaskRecordOptions = {
      actor: ctx.actor,
      groups: ctx.permissionGroups ?? permissionGroups,
      capabilityName: schemaDef.name,
    };
    const masked = maskRecord(record, schemaDef, maskOpts);

    // Coerce masked non-string fields to null — GraphQL cannot serialize
    // a mask placeholder string (e.g. "***") as Float, Boolean, or Date.
    for (const [fieldName, fieldDef] of Object.entries(schemaDef.fields)) {
      if (
        NON_STRING_FIELD_TYPES.has(fieldDef.type) &&
        typeof masked[fieldName] === "string" &&
        masked[fieldName] !== record[fieldName]
      ) {
        masked[fieldName] = null;
      }
    }

    return masked;
  };

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

  // Pre-generate object types to reuse for both CRUD and custom action return types.
  // Pass the typeMap and links so that relation fields can reference other types lazily.
  const schemaObjectTypes = new Map<string, GraphQLObjectType>();
  for (const schema of schemas) {
    schemaObjectTypes.set(
      schema.name,
      generateGraphQLObjectType(
        schema,
        undefined,
        links.length > 0 ? links : undefined,
        links.length > 0 ? schemaObjectTypes : undefined,
      ),
    );
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
        locale: { type: GraphQLString, description: "Locale for translatable fields" },
      },
      resolve: dataProvider
        ? async (_root: unknown, args: { id: string; locale?: string }, ctx: GraphQLContext) => {
            const locale = args.locale ?? ctx.locale;
            const opts: DataQueryOptions = {
              ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
              ...(locale ? { locale } : {}),
            };
            try {
              const record = await dataProvider.get(
                schemaName,
                args.id,
                Object.keys(opts).length > 0 ? opts : undefined,
              );
              if (!record) return null;
              // Resolve compute-strategy derived fields on read
              if (derivedEngine) {
                derivedEngine.resolveComputeFields(schemaName, record as Record<string, unknown>);
              }
              return applyMasking(record as Record<string, unknown>, schemaName, ctx);
            } catch (err) {
              console.error(`[GraphQL] Failed to resolve ${schemaName} id=${args.id}:`, err);
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
        locale: { type: GraphQLString, description: "Locale for translatable fields" },
      },
      resolve: dataProvider
        ? async (
            _root: unknown,
            args: {
              filter?: string;
              sortField?: string;
              sortOrder?: string;
              page?: number;
              pageSize?: number;
              locale?: string;
            },
            ctx: GraphQLContext,
          ) => {
            const locale = args.locale ?? ctx.locale;
            const opts: DataQueryOptions = {
              ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
              ...(locale ? { locale } : {}),
            };
            const optsOrUndefined = Object.keys(opts).length > 0 ? opts : undefined;
            const filter = args.filter
              ? (safeParseJSON(args.filter, "filter") as Record<string, unknown>)
              : {};
            const page = args.page ?? 1;
            const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), MAX_PAGE_SIZE);
            const offset = (page - 1) * pageSize;

            // Pass pagination and sort as part of the filter object
            // DataProvider.query() supports these meta keys
            const queryFilter: Record<string, unknown> = {
              ...filter,
              offset,
              limit: pageSize,
            };
            if (args.sortField) {
              queryFilter.sortField = args.sortField;
              queryFilter.sortOrder = args.sortOrder ?? "asc";
            }

            const rawItems = await dataProvider.query(schemaName, queryFilter, optsOrUndefined);
            const total = await dataProvider.count(schemaName, filter, optsOrUndefined);
            // Resolve compute-strategy derived fields on read, then apply data masking
            const items = (rawItems as Record<string, unknown>[]).map((r) => {
              if (derivedEngine) {
                derivedEngine.resolveComputeFields(schemaName, r);
              }
              return applyMasking(r, schemaName, ctx);
            });
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
        ? async (_root: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) => {
            const locale = ctx.locale;
            const result = await executor.execute(`create_${schemaName}`, args.input, ctx.actor, {
              channel: "http",
              tenantId: ctx.tenantId,
              locale,
            });
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new Error((errData?.error as string) ?? "Create action failed");
            }
            const data = result.data as Record<string, unknown>;
            return data ? resolveTranslatableRow(data, schema, locale) : data;
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
        _version: {
          type: GraphQLInt,
          description: "Expected record version for optimistic locking",
        },
      },
      resolve: executor
        ? async (
            _root: unknown,
            args: { id: string; input: Record<string, unknown>; _version?: number },
            ctx: GraphQLContext,
          ) => {
            const locale = ctx.locale;
            const input: Record<string, unknown> = { id: args.id, ...args.input };
            // Pass _version through for optimistic locking when provided
            if (args._version !== undefined && args._version !== null) {
              input._version = args._version;
            }
            const result = await executor.execute(`update_${schemaName}`, input, ctx.actor, {
              channel: "http",
              tenantId: ctx.tenantId,
              locale,
            });
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new Error((errData?.error as string) ?? "Update action failed");
            }
            const data = result.data as Record<string, unknown>;
            return data ? resolveTranslatableRow(data, schema, locale) : data;
          }
        : (
            _root: unknown,
            args: { id: string; input: Record<string, unknown>; _version?: number },
          ) => ({
            ...mockRecord,
            ...args.input,
            id: args.id,
            updated_at: new Date().toISOString(),
            _version: args._version !== undefined ? args._version + 1 : 2,
          }),
    };

    // ── Mutation: delete ──────────────────────────────────
    mutationFields[`delete${pascalName}`] = {
      type: GraphQLBoolean,
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
      },
      resolve: executor
        ? async (_root: unknown, args: { id: string }, ctx: GraphQLContext) => {
            const result = await executor.execute(
              `delete_${schemaName}`,
              { id: args.id },
              ctx.actor,
              { channel: "http", tenantId: ctx.tenantId, locale: ctx.locale },
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
        ctx: GraphQLContext,
      ) =>
        executionLogger.findMany({
          tenantId: ctx.tenantId,
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
      resolve: async (_root: unknown, args: { id: string }, ctx: GraphQLContext) => {
        const entry = await executionLogger.getById(args.id);
        if (!entry) return null;
        // Tenant isolation: reject if entry belongs to a different tenant
        if (ctx.tenantId && entry.tenantId !== ctx.tenantId) return null;
        return entry;
      },
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

    // Capture the schema definition for translatable resolution in custom actions
    const actionSchema = action.schema ? schemas.find((s) => s.name === action.schema) : undefined;

    mutationFields[mutationName] = {
      type: returnType,
      description: action.description ?? action.label,
      args,
      resolve: executor
        ? async (
            _root: unknown,
            resolverArgs: { id: string; input?: Record<string, unknown> },
            ctx: GraphQLContext,
          ) => {
            const locale = ctx.locale;
            // Spread input first so explicit id argument takes precedence
            const input: Record<string, unknown> = {
              ...resolverArgs.input,
              id: resolverArgs.id,
            };
            const result = await executor.execute(actionName, input, ctx.actor, {
              channel: "http",
              tenantId: ctx.tenantId,
              locale,
            });
            if (returnsSchemaType) {
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                throw new Error((errData?.error as string) ?? `Action "${actionName}" failed`);
              }
              const data = result.data as Record<string, unknown>;
              return data && actionSchema
                ? resolveTranslatableRow(data, actionSchema, locale)
                : data;
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
      ? async (_root: unknown, args: { name: string; input: string }, ctx: GraphQLContext) => {
          const input = safeParseJSON(args.input, "input") as Record<string, unknown>;
          const result = await executor.execute(args.name, input, ctx.actor, {
            channel: "http",
            tenantId: ctx.tenantId,
            locale: ctx.locale,
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

  // Build subscription type when EventBus is available
  let subscription: GraphQLObjectType | undefined;
  let cleanupSubscriptions: (() => void) | undefined;
  if (eventBus) {
    const { pubsub, unsubscribe } = createEventBusPubSub(eventBus);
    cleanupSubscriptions = unsubscribe;
    const subscriptionFields = buildSubscriptionFields({
      schemas,
      schemaObjectTypes,
      pubsub,
    });
    if (subscriptionFields) {
      subscription = new GraphQLObjectType({
        name: "Subscription",
        fields: subscriptionFields,
      });
    }
  }

  const schema = new GraphQLSchema({ query, mutation, subscription });
  return Object.assign(schema, { cleanup: cleanupSubscriptions });
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
