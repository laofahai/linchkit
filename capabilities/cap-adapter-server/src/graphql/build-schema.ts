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
  DerivedPropertyEngine,
  EventBus,
  LinkDefinition,
  MaskRecordOptions,
  PermissionGroupDefinition,
  SchemaDefinition,
  StateDefinition,
} from "@linchkit/core";
import { normalizeTranslatableRow, resolveTranslatableRow } from "@linchkit/core";
import type { CacheManager } from "@linchkit/core/server";
import { createStateMachine, getAvailableTransitions, maskRecord } from "@linchkit/core/server";

export { type GenerateCrudActionsOptions, generateCrudActions } from "./build-crud-actions";

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
  /** Per-request DataLoaders for batched link resolution (avoids N+1 queries) */
  linkLoaders?: import("./link-dataloader").LinkDataLoaders;
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
    // JSON.parse failed — convert to a user-facing GraphQL error
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

// ── Schema builder options ──────────────────────────────────

export interface BuildGraphQLSchemaOptions {
  /** Action executor for wiring mutations */
  executor?: ActionExecutor;
  /** Data provider for query resolvers (get, query, count) */
  dataProvider?: DataProvider;
  /** Custom actions to generate typed mutations for (beyond auto-generated CRUD) */
  actions?: ActionDefinition[];
  /** Link definitions for generating bidirectional relation resolver fields */
  links?: LinkDefinition[];
  /** Cache manager for caching query results (optional — queries go direct when absent) */
  cacheManager?: CacheManager;
  /** Event bus for wiring GraphQL subscriptions (real-time CRUD events via SSE) */
  eventBus?: EventBus;
  /** Permission groups for data masking (unmask permission checks) */
  permissionGroups?: PermissionGroupDefinition[];
  /** Derived property engine for auto-computing derived fields on read and write */
  derivedPropertyEngine?: DerivedPropertyEngine;
  /** State definitions for generating transition queries/mutations and validating state changes */
  stateDefinitions?: StateDefinition[];
  /** Schema names that are internal (read-only) — skip mutation generation for these */
  internalSchemas?: Set<string>;
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
  const links = options?.links ?? [];
  const eventBus = options?.eventBus;
  const permissionGroups = options?.permissionGroups ?? [];
  const derivedEngine = options?.derivedPropertyEngine;
  const stateDefinitions = options?.stateDefinitions ?? [];
  const cacheManager = options?.cacheManager;
  const internalSchemas = options?.internalSchemas ?? new Set<string>();

  /** Default TTL for GraphQL query cache entries (30s) */
  const GQL_CACHE_TTL = 30_000;

  /** Cache-aware wrapper: try cache first, fall back to loader, store result */
  async function cachedQuery<T>(
    cacheKey: string,
    tags: string[],
    loader: () => Promise<T>,
  ): Promise<T> {
    if (!cacheManager) return loader();
    const cached = cacheManager.get<T>(cacheKey);
    if (cached !== undefined) return cached;
    const result = await loader();
    cacheManager.set(cacheKey, result, { ttl: GQL_CACHE_TTL, tags });
    return result;
  }

  /** Invalidate all cached queries for a given schema name */
  function invalidateSchemaCache(schemaName: string): void {
    if (!cacheManager) return;
    cacheManager.invalidateByPrefix(`gql:${schemaName}:`);
  }

  // Build state machine lookup: machine name → StateMachine instance
  const stateMachineMap = new Map<string, ReturnType<typeof createStateMachine>>();
  for (const sd of stateDefinitions) {
    stateMachineMap.set(sd.name, createStateMachine(sd));
  }

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

  // Schemas with manually-defined GraphQL types must be excluded from auto-generation
  // to avoid type name collisions (e.g. execution_log has custom ExecutionLogListResult).
  const schemasWithCustomTypes = new Set<string>();
  // execution_log is now auto-generated; manual queries use renamed types to avoid collision

  const autoSchemas = schemas.filter((s) => !schemasWithCustomTypes.has(s.name));

  // Pre-generate object types to reuse for both CRUD and custom action return types.
  // Pass the typeMap and links so that relation fields can reference other types lazily.
  const schemaObjectTypes = new Map<string, GraphQLObjectType>();
  for (const schema of autoSchemas) {
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

  for (const schema of autoSchemas) {
    const objectType = schemaObjectTypes.get(schema.name);
    if (!objectType) continue;
    const inputType = generateGraphQLInputType(schema, undefined, links);
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
            const cacheKey = `gql:${schemaName}:${args.id}:${locale ?? ""}:${ctx.tenantId ?? ""}`;
            const tags = [`gql:${schemaName}`, `schema:${schemaName}`];
            return cachedQuery(cacheKey, tags, async () => {
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
                // Resolve compute-strategy derived fields on read (async to support aggregates)
                if (derivedEngine) {
                  await derivedEngine.resolveComputeFieldsAsync(schemaName, record as Record<string, unknown>);
                }
                // Resolve translatable JSONB → plain strings BEFORE masking,
                // so masking always operates on strings, not locale-map objects.
                const resolved = resolveTranslatableRow(
                  record as Record<string, unknown>,
                  schema,
                  locale,
                );
                return applyMasking(resolved, schemaName, ctx);
              } catch (err) {
                console.error(`[GraphQL] Failed to resolve ${schemaName} id=${args.id}:`, err);
                return null;
              }
            });
          }
        : (_root: unknown, args: { id: string }) => ({
            ...mockRecord,
            id: args.id,
          }),
    };

    // ── PageInfo type for pagination metadata ──────────
    const pageInfoType = new GraphQLObjectType({
      name: `${pascalName}PageInfo`,
      fields: {
        limit: { type: new GraphQLNonNull(GraphQLInt) },
        offset: { type: new GraphQLNonNull(GraphQLInt) },
        hasMore: { type: new GraphQLNonNull(GraphQLBoolean) },
      },
    });

    // ── ListResult type for paginated responses ──────────
    const listResultType = new GraphQLObjectType({
      name: `${pascalName}ListResult`,
      fields: {
        items: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
        },
        total: { type: new GraphQLNonNull(GraphQLInt) },
        pageInfo: { type: new GraphQLNonNull(pageInfoType) },
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
        search: {
          type: GraphQLString,
          description: "Full-text search keyword (ILIKE across all string fields)",
        },
        sortField: { type: GraphQLString, description: "Field to sort by (default: created_at)" },
        sortOrder: {
          type: GraphQLString,
          description: "Sort order: asc or desc (default: desc)",
        },
        page: { type: GraphQLInt, description: "Page number (1-based)" },
        pageSize: { type: GraphQLInt, description: "Number of items per page" },
        locale: { type: GraphQLString, description: "Locale for translatable fields" },
        includeDeleted: {
          type: GraphQLBoolean,
          description: "Include soft-deleted records (default: false)",
        },
      },
      resolve: dataProvider
        ? async (
            _root: unknown,
            args: {
              filter?: string;
              search?: string;
              sortField?: string;
              sortOrder?: string;
              page?: number;
              pageSize?: number;
              locale?: string;
              includeDeleted?: boolean;
            },
            ctx: GraphQLContext,
          ) => {
            const locale = args.locale ?? ctx.locale;
            const listCacheKey = `gql:${schemaName}:list:${JSON.stringify(args)}:${locale ?? ""}:${ctx.tenantId ?? ""}`;
            const tags = [`gql:${schemaName}`, `schema:${schemaName}`];
            return cachedQuery(listCacheKey, tags, async () => {
              const opts: DataQueryOptions = {
                ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
                ...(locale ? { locale } : {}),
                ...(args.includeDeleted ? { includeDeleted: true } : {}),
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
              // Default sort: created_at DESC (newest first)
              const sortField = args.sortField ?? "created_at";
              const sortOrder = args.sortOrder ?? "desc";
              const queryFilter: Record<string, unknown> = {
                ...filter,
                offset,
                limit: pageSize,
                sortField,
                sortOrder,
                ...(args.search ? { search: args.search } : {}),
              };

              // Count filter includes search but not pagination/sort
              const countFilter: Record<string, unknown> = {
                ...filter,
                ...(args.search ? { search: args.search } : {}),
              };

              const rawItems = await dataProvider.query(schemaName, queryFilter, optsOrUndefined);
              const total = await dataProvider.count(schemaName, countFilter, optsOrUndefined);
              // Resolve compute-strategy derived fields on read, then resolve
              // translatable JSONB → plain strings BEFORE masking so masking
              // always operates on strings, not locale-map objects.
              const items = await Promise.all((rawItems as Record<string, unknown>[]).map(async (r) => {
                if (derivedEngine) {
                  await derivedEngine.resolveComputeFieldsAsync(schemaName, r);
                }
                const resolved = resolveTranslatableRow(r, schema, locale);
                return applyMasking(resolved, schemaName, ctx);
              }));
              const hasMore = offset + items.length < total;
              return { items, total, pageInfo: { limit: pageSize, offset, hasMore } };
            });
          }
        : () => ({ items: [], total: 0, pageInfo: { limit: 20, offset: 0, hasMore: false } }),
    };

    // Internal schemas are read-only — skip mutation generation
    if (internalSchemas.has(schemaName)) {
      continue;
    }

    // ── Mutation: create ──────────────────────────────────
    mutationFields[`create${pascalName}`] = {
      type: objectType,
      args: {
        input: { type: new GraphQLNonNull(inputType) },
      },
      resolve: executor
        ? async (_root: unknown, args: { input: Record<string, unknown> }, ctx: GraphQLContext) => {
            const locale = ctx.locale;
            const normalizedInput = normalizeTranslatableRow(args.input, schema, locale);
            const result = await executor.execute(
              `create_${schemaName}`,
              normalizedInput,
              ctx.actor,
              {
                channel: "http",
                tenantId: ctx.tenantId,
                locale,
              },
            );
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new Error((errData?.error as string) ?? "Create action failed");
            }
            invalidateSchemaCache(schemaName);
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
            // Strip state-type fields — status changes must go through
            // action engine / state machine transitions, not raw CRUD updates.
            const sanitizedInput: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(args.input)) {
              const fieldDef = schema.fields[key];
              if (fieldDef && fieldDef.type === "state") continue;
              sanitizedInput[key] = value;
            }
            const normalizedArgs = normalizeTranslatableRow(sanitizedInput, schema, locale);
            const input: Record<string, unknown> = { id: args.id, ...normalizedArgs };
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
              const errorMessage = (errData?.error as string) ?? "Update action failed";
              // Surface version conflict as a GraphQLError with CONFLICT code
              if (errorMessage.includes("Version conflict")) {
                throw new GraphQLError(errorMessage, {
                  extensions: { code: "CONFLICT", http: { status: 409 } },
                });
              }
              // Surface state transition errors as a GraphQLError with CONFLICT code
              if (errorMessage.includes("State transition not allowed")) {
                throw new GraphQLError(errorMessage, {
                  extensions: { code: "STATE_TRANSITION_DENIED", http: { status: 409 } },
                });
              }
              throw new Error(errorMessage);
            }
            invalidateSchemaCache(schemaName);
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
            if (result.success) invalidateSchemaCache(schemaName);
            return result.success;
          }
        : () => true,
    };

    // ── Mutation: restore (clear soft delete) ───────────────
    mutationFields[`restore${pascalName}`] = {
      type: objectType,
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
      },
      resolve: executor
        ? async (_root: unknown, args: { id: string }, ctx: GraphQLContext) => {
            const locale = ctx.locale;
            const result = await executor.execute(
              `restore_${schemaName}`,
              { id: args.id },
              ctx.actor,
              { channel: "http", tenantId: ctx.tenantId, locale, includeDeleted: true },
            );
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new GraphQLError(
                (errData?.error as string) ?? `Failed to restore ${schemaName} id=${args.id}`,
              );
            }
            invalidateSchemaCache(schemaName);
            const data = result.data as Record<string, unknown>;
            return data ? resolveTranslatableRow(data, schema, locale) : data;
          }
        : () => null,
    };

    // ── State transition query + mutation ──────────────────
    // For each state field, find the associated state machine and generate
    // availableTransitions query and transition mutation.
    const stateFields = Object.entries(schema.fields).filter(([, f]) => f.type === "state");
    for (const [stateFieldName, stateField] of stateFields) {
      if (stateField.type !== "state") continue;
      const machineName = stateField.machine;
      const machine = stateMachineMap.get(machineName);
      if (!machine) continue;

      // ── Query: availableTransitions{PascalName}(id: ID!) ──
      const transitionType = new GraphQLObjectType({
        name: `${pascalName}AvailableTransition`,
        fields: {
          from: { type: new GraphQLNonNull(GraphQLString) },
          to: { type: new GraphQLNonNull(GraphQLString) },
          action: { type: new GraphQLNonNull(GraphQLString) },
          allowed: { type: new GraphQLNonNull(GraphQLBoolean) },
          reason: { type: GraphQLString },
        },
      });

      queryFields[`${camelName}AvailableTransitions`] = {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(transitionType))),
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
        },
        resolve: dataProvider
          ? async (_root: unknown, args: { id: string }, ctx: GraphQLContext) => {
              const opts: DataQueryOptions = {
                ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
              };
              const optsOrUndefined = Object.keys(opts).length > 0 ? opts : undefined;
              try {
                const record = await dataProvider.get(schemaName, args.id, optsOrUndefined);
                if (!record) return [];
                const currentState =
                  (record[stateFieldName] as string) ?? machine.definition.initial ?? "";
                const transitions = getAvailableTransitions(machine, currentState);
                // Enrich each transition with permission pre-check from action definitions
                return transitions.map((tr) => {
                  const actor = ctx.actor;
                  // Check both transition action and update action permissions
                  const actionNames = [tr.action, `update_${schemaName}`];
                  for (const name of actionNames) {
                    const actionDef = executor?.registry.get(name);
                    const perms = actionDef?.permissions;
                    if (!perms) continue;
                    if (perms.actorTypes?.length && !perms.actorTypes.includes(actor.type)) {
                      return {
                        ...tr,
                        allowed: false,
                        reason: `Actor type "${actor.type}" is not allowed`,
                      };
                    }
                    if (perms.groups?.length) {
                      const hasGroup = actor.groups.some((g) => perms.groups?.includes(g));
                      if (!hasGroup) {
                        return {
                          ...tr,
                          allowed: false,
                          reason: `Requires group: ${perms.groups.join(", ")}`,
                        };
                      }
                    }
                  }
                  return { ...tr, allowed: true, reason: null };
                });
              } catch {
                // State definition lookup failed — return empty transitions list
                return [];
              }
            }
          : () => [],
      };

      // ── Mutation: transition{PascalName}(id: ID!, to: String!) ──
      mutationFields[`transition${pascalName}`] = {
        type: objectType,
        description: `Transition ${schema.label ?? schemaName} to a new state`,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          to: { type: new GraphQLNonNull(GraphQLString) },
        },
        resolve:
          executor && dataProvider
            ? async (_root: unknown, args: { id: string; to: string }, ctx: GraphQLContext) => {
                const opts: DataQueryOptions = {
                  ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
                };
                const optsOrUndefined = Object.keys(opts).length > 0 ? opts : undefined;

                // Fetch current record to get current state
                let record: Record<string, unknown>;
                try {
                  record = await dataProvider.get(schemaName, args.id, optsOrUndefined);
                } catch {
                  // DataProvider.get threw (record missing or DB error) — surface as GraphQL error
                  throw new GraphQLError(`Record "${args.id}" not found in "${schemaName}"`);
                }
                if (!record) {
                  throw new GraphQLError(`Record "${args.id}" not found in "${schemaName}"`);
                }
                const currentState =
                  (record[stateFieldName] as string) ?? machine.definition.initial ?? "";

                // Validate the transition is allowed
                const available = getAvailableTransitions(machine, currentState);
                const match = available.find((t) => t.to === args.to);
                if (!match) {
                  throw new GraphQLError(
                    `State transition not allowed: cannot transition from "${currentState}" to "${args.to}"`,
                  );
                }

                // Execute the update via the action engine so all middleware/logging applies
                const input: Record<string, unknown> = {
                  id: args.id,
                  [stateFieldName]: args.to,
                };
                const result = await executor.execute(`update_${schemaName}`, input, ctx.actor, {
                  channel: "http",
                  tenantId: ctx.tenantId,
                  locale: ctx.locale,
                });
                if (!result.success) {
                  const errData = result.data as Record<string, unknown> | undefined;
                  throw new GraphQLError((errData?.error as string) ?? `State transition failed`);
                }
                invalidateSchemaCache(schemaName);
                const data = result.data as Record<string, unknown>;
                return data ? resolveTranslatableRow(data, schema, ctx.locale) : data;
              }
            : () => {
                throw new GraphQLError("Executor or data provider not configured");
              },
      };
    }
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
