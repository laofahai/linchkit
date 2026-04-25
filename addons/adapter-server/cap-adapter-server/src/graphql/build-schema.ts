/**
 * Build a complete GraphQL schema from LinchKit EntityDefinitions.
 *
 * Generates Query and Mutation types wired to the Action Engine
 * and an in-memory DataProvider. Includes CRUD mutations for each
 * schema plus a generic executeAction mutation.
 */

import type {
  ActionDefinition,
  ActionExecutor,
  ActionResult,
  Actor,
  CommandLayer,
  DataProvider,
  DataQueryOptions,
  DerivedPropertyEngine,
  EntityDefinition,
  EventBus,
  MaskRecordOptions,
  PermissionGroupDefinition,
  RelationDefinition,
  StateDefinition,
} from "@linchkit/core";
import { normalizeTranslatableRow, resolveTranslatableRow } from "@linchkit/core";
import type { CacheManager, OnchangeEvaluator, OverlayRegistry } from "@linchkit/core/server";
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
import { buildOnchangeMutationFields } from "./build-onchange-mutations";
import { buildSubscriptionFields, createEventBusPubSub } from "./build-subscriptions";
import {
  generateActionInputType,
  generateGraphQLInputType,
  generateGraphQLObjectType,
} from "./schema-to-graphql";

const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * Sanitize an arbitrary identifier to a valid GraphQL field-name component
 * by replacing any disallowed character with `_` and prefixing the result
 * with `_` if it does not start with a letter or underscore. Preserves
 * snake_case for entity names — used by call sites that build composite
 * names like `<entity>_onchange` and want the entity portion intact.
 */
export function sanitizeGraphQLFieldName(name: string): string {
  const replaced = name.replace(/[^_0-9A-Za-z]/g, "_");
  return GRAPHQL_NAME_RE.test(replaced) ? replaced : `_${replaced}`;
}

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
  /** Entity definitions map for link resolver data masking */
  entityMap?: Map<string, EntityDefinition>;
  /** Per-request DataLoaders for batched link resolution (avoids N+1 queries) */
  relationLoaders?: import("./relation-dataloader").RelationDataLoaders;
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
  /**
   * Action executor for wiring mutations. When `commandLayer` is also
   * provided, the resolvers prefer the pipeline so cap-permission and other
   * CommandLayer slots protect GraphQL mutations the same way they protect
   * REST (issue #125). Raw `executor` is retained as a fallback for test
   * setups that don't build a CommandLayer.
   */
  executor?: ActionExecutor;
  /**
   * CommandLayer pipeline. When present, GraphQL mutation resolvers route
   * through `commandLayer.execute(...)` instead of calling `executor.execute`
   * directly — this is the supported production path (cap-permission and
   * other slot middleware only run on the pipeline).
   */
  commandLayer?: CommandLayer;
  /** Data provider for query resolvers (get, query, count) */
  dataProvider?: DataProvider;
  /** Custom actions to generate typed mutations for (beyond auto-generated CRUD) */
  actions?: ActionDefinition[];
  /** Relation definitions for generating bidirectional relation resolver fields */
  relations?: RelationDefinition[];
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
  /** Extra query fields from capability graphqlExtensions */
  extraQueryFields?: Record<string, GraphQLFieldConfig<unknown, unknown>>;
  /** Extra mutation fields from capability graphqlExtensions */
  extraMutationFields?: Record<string, GraphQLFieldConfig<unknown, unknown>>;
  /** Overlay registry for dynamic runtime fields (Phase 3 — overlay fields in GraphQL) */
  overlayRegistry?: OverlayRegistry;
  /**
   * Onchange evaluator (Spec 64) — when provided alongside `commandLayer`,
   * each entity that declares an `onchange` map gets an auto-generated
   * `<entity>_onchange` mutation. Without both, the GraphQL surface omits
   * the mutation entirely (mirrors REST 503 behavior of skipping the route).
   */
  onchangeEvaluator?: OnchangeEvaluator;
}

/**
 * Build a complete GraphQL schema from an array of EntityDefinitions.
 *
 * For each schema, generates:
 * - Query: `{camelName}(id: ID!): Type` and `{camelName}List: [Type!]!`
 * - Mutation: `create{PascalName}`, `update{PascalName}`, `delete{PascalName}`
 *
 * When executor/store are provided, resolvers are wired to actual data.
 * Otherwise falls back to stub/mock resolvers for backward compatibility.
 */
export function buildGraphQLSchema(
  entities: EntityDefinition[],
  options?: BuildGraphQLSchemaOptions,
): GraphQLSchema {
  const executor = options?.executor;
  const commandLayer = options?.commandLayer;
  const dataProvider = options?.dataProvider;

  /**
   * Dispatch a named action through the production pipeline when available,
   * falling back to the raw executor for test setups that don't supply a
   * CommandLayer. Preferring commandLayer means cap-permission and any other
   * permission-slot middleware actually protect GraphQL mutations (issue #125).
   */
  const dispatchAction = async <T = unknown>(
    name: string,
    input: Record<string, unknown>,
    ctx: GraphQLContext,
    extraOptions?: { includeDeleted?: boolean; meta?: Record<string, unknown> },
  ): Promise<ActionResult<T>> => {
    // Prefer CommandLayer so cap-permission and other slot middleware
    // protect every GraphQL mutation, including restore_* flows. The
    // CommandExecuteOptions surface carries `includeDeleted` now, so these
    // actions no longer need a raw-executor escape hatch.
    if (commandLayer) {
      return (await commandLayer.execute({
        command: name,
        input,
        actor: ctx.actor,
        channel: "http",
        tenantId: ctx.tenantId,
        locale: ctx.locale,
        includeDeleted: extraOptions?.includeDeleted,
        meta: extraOptions?.meta,
      })) as ActionResult<T>;
    }
    if (!executor) {
      throw new Error("GraphQL mutation requires either options.commandLayer or options.executor");
    }
    return executor.execute(name, input, ctx.actor, {
      channel: "http",
      tenantId: ctx.tenantId,
      locale: ctx.locale,
      includeDeleted: extraOptions?.includeDeleted,
      meta: extraOptions?.meta,
    }) as Promise<ActionResult<T>>;
  };

  /** True when at least one execution path is available — guards mutation resolvers. */
  const hasDispatcher = Boolean(commandLayer) || Boolean(executor);
  const relations = options?.relations ?? [];
  const eventBus = options?.eventBus;
  const permissionGroups = options?.permissionGroups ?? [];
  const derivedEngine = options?.derivedPropertyEngine;
  const stateDefinitions = options?.stateDefinitions ?? [];
  const cacheManager = options?.cacheManager;
  const internalSchemas = options?.internalSchemas ?? new Set<string>();
  const overlayRegistry = options?.overlayRegistry;

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

  /** Invalidate all cached queries for a given entity name */
  function invalidateEntityCache(entityName: string): void {
    if (!cacheManager) return;
    cacheManager.invalidateByPrefix(`gql:${entityName}:`);
  }

  // Build state machine lookup: machine name → StateMachine instance
  const stateMachineMap = new Map<string, ReturnType<typeof createStateMachine>>();
  for (const sd of stateDefinitions) {
    stateMachineMap.set(sd.name, createStateMachine(sd));
  }

  // Build entity lookup map for data masking
  const entityMap = new Map<string, EntityDefinition>();
  for (const s of entities) {
    entityMap.set(s.name, s);
  }

  /** Field types whose masked values cannot be represented as strings in GraphQL (must become null) */
  const NON_STRING_FIELD_TYPES = new Set(["number", "boolean", "date", "datetime", "json"]);

  /** Apply data masking to a record based on actor permissions */
  const applyMasking = (
    record: Record<string, unknown>,
    entityName: string,
    ctx: GraphQLContext,
  ): Record<string, unknown> => {
    const entityDef = entityMap.get(entityName);
    if (!entityDef) return record;
    const maskOpts: MaskRecordOptions = {
      actor: ctx.actor,
      groups: ctx.permissionGroups ?? permissionGroups,
      capabilityName: entityDef.name,
    };
    const masked = maskRecord(record, entityDef, maskOpts);

    // Coerce masked non-string fields to null — GraphQL cannot serialize
    // a mask placeholder string (e.g. "***") as Float, Boolean, or Date.
    for (const [fieldName, fieldDef] of Object.entries(entityDef.fields)) {
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

  if (entities.length === 0) {
    // Return a minimal valid schema with a placeholder query (plus any extra fields)
    const minimalQueryFields: Record<string, GraphQLFieldConfig<unknown, unknown>> = {
      _empty: {
        type: GraphQLString,
        resolve: () => "No entities registered",
      },
      ...options?.extraQueryFields,
    };
    const minimalMutationFields = options?.extraMutationFields;
    return new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: minimalQueryFields,
      }),
      ...(minimalMutationFields && Object.keys(minimalMutationFields).length > 0
        ? {
            mutation: new GraphQLObjectType({
              name: "Mutation",
              fields: minimalMutationFields,
            }),
          }
        : {}),
    });
  }

  const queryFields: Record<string, unknown> = {};
  const mutationFields: Record<string, unknown> = {};

  // Schemas with manually-defined GraphQL types must be excluded from auto-generation
  // to avoid type name collisions (e.g. execution_log has custom ExecutionLogListResult).
  const entitiesWithCustomTypes = new Set<string>();
  // execution_log is now auto-generated; manual queries use renamed types to avoid collision

  const autoEntities = entities.filter((s) => !entitiesWithCustomTypes.has(s.name));

  // Pre-generate object types to reuse for both CRUD and custom action return types.
  // Pass the typeMap and relations so that relation fields can reference other types lazily.
  // When overlayRegistry is available, overlay fields are included on entity types.
  const entityObjectTypes = new Map<string, GraphQLObjectType>();
  for (const entity of autoEntities) {
    const entityOverlays = overlayRegistry?.overlaysFor(entity.name);
    entityObjectTypes.set(
      entity.name,
      generateGraphQLObjectType(
        entity,
        undefined,
        relations.length > 0 ? relations : undefined,
        relations.length > 0 ? entityObjectTypes : undefined,
        entityOverlays?.length ? entityOverlays : undefined,
      ),
    );
  }

  for (const entity of autoEntities) {
    const objectType = entityObjectTypes.get(entity.name);
    if (!objectType) continue;
    const entityOverlays = overlayRegistry?.overlaysFor(entity.name);
    const inputType = generateGraphQLInputType(
      entity,
      undefined,
      relations,
      entityOverlays?.length ? entityOverlays : undefined,
    );
    const camelName = toCamelCase(entity.name);
    const pascalName = toPascalCase(entity.name);
    const entityName = entity.name;

    // Build a mock record for fallback stub resolvers
    const mockRecord = buildMockRecord(entity);

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
            const cacheKey = `gql:${entityName}:${args.id}:${locale ?? ""}:${ctx.tenantId ?? ""}`;
            const tags = [`gql:${entityName}`, `entity:${entityName}`];
            return cachedQuery(cacheKey, tags, async () => {
              const opts: DataQueryOptions = {
                ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
                ...(locale ? { locale } : {}),
              };
              try {
                const record = await dataProvider.get(
                  entityName,
                  args.id,
                  Object.keys(opts).length > 0 ? opts : undefined,
                );
                if (!record) return null;
                // Resolve compute-strategy derived fields on read (async to support aggregates)
                if (derivedEngine) {
                  await derivedEngine.resolveComputeFieldsAsync(
                    entityName,
                    record as Record<string, unknown>,
                  );
                }
                // Resolve translatable JSONB → plain strings BEFORE masking,
                // so masking always operates on strings, not locale-map objects.
                const resolved = resolveTranslatableRow(
                  record as Record<string, unknown>,
                  entity,
                  locale,
                );
                return applyMasking(resolved, entityName, ctx);
              } catch (err) {
                console.error(`[GraphQL] Failed to resolve ${entityName} id=${args.id}:`, err);
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
            const listCacheKey = `gql:${entityName}:list:${JSON.stringify(args)}:${locale ?? ""}:${ctx.tenantId ?? ""}`;
            const tags = [`gql:${entityName}`, `entity:${entityName}`];
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

              const rawItems = await dataProvider.query(entityName, queryFilter, optsOrUndefined);
              const total = await dataProvider.count(entityName, countFilter, optsOrUndefined);
              // Resolve compute-strategy derived fields on read, then resolve
              // translatable JSONB → plain strings BEFORE masking so masking
              // always operates on strings, not locale-map objects.
              const items = await Promise.all(
                (rawItems as Record<string, unknown>[]).map(async (r) => {
                  if (derivedEngine) {
                    await derivedEngine.resolveComputeFieldsAsync(entityName, r);
                  }
                  const resolved = resolveTranslatableRow(r, entity, locale);
                  return applyMasking(resolved, entityName, ctx);
                }),
              );
              const hasMore = offset + items.length < total;
              return { items, total, pageInfo: { limit: pageSize, offset, hasMore } };
            });
          }
        : () => ({ items: [], total: 0, pageInfo: { limit: 20, offset: 0, hasMore: false } }),
    };

    // Internal schemas are read-only — skip mutation generation
    if (internalSchemas.has(entityName)) {
      continue;
    }

    // ── Mutation: create ──────────────────────────────────
    mutationFields[`create${pascalName}`] = {
      type: objectType,
      args: {
        input: { type: new GraphQLNonNull(inputType) },
        meta: {
          type: GraphQLString,
          description: "JSON-encoded execution meta (Spec 65 §3.2)",
        },
      },
      resolve: hasDispatcher
        ? async (
            _root: unknown,
            args: { input: Record<string, unknown>; meta?: string },
            ctx: GraphQLContext,
          ) => {
            const locale = ctx.locale;
            const normalizedInput = normalizeTranslatableRow(args.input, entity, locale);
            const meta = args.meta ? safeParseJSON(args.meta, "meta") : undefined;
            const result = await dispatchAction(`create_${entityName}`, normalizedInput, ctx, {
              meta,
            });
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new Error((errData?.error as string) ?? "Create action failed");
            }
            invalidateEntityCache(entityName);
            const data = result.data as Record<string, unknown>;
            return data ? resolveTranslatableRow(data, entity, locale) : data;
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
        meta: {
          type: GraphQLString,
          description: "JSON-encoded execution meta (Spec 65 §3.2)",
        },
      },
      resolve: hasDispatcher
        ? async (
            _root: unknown,
            args: {
              id: string;
              input: Record<string, unknown>;
              _version?: number;
              meta?: string;
            },
            ctx: GraphQLContext,
          ) => {
            const locale = ctx.locale;
            // Strip state-type fields — status changes must go through
            // action engine / state machine transitions, not raw CRUD updates.
            const sanitizedInput: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(args.input)) {
              const fieldDef = entity.fields[key];
              if (fieldDef && fieldDef.type === "state") continue;
              sanitizedInput[key] = value;
            }
            const normalizedArgs = normalizeTranslatableRow(sanitizedInput, entity, locale);
            const input: Record<string, unknown> = { id: args.id, ...normalizedArgs };
            // Pass _version through for optimistic locking when provided
            if (args._version !== undefined && args._version !== null) {
              input._version = args._version;
            }
            const meta = args.meta ? safeParseJSON(args.meta, "meta") : undefined;
            const result = await dispatchAction(`update_${entityName}`, input, ctx, { meta });
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
            invalidateEntityCache(entityName);
            const data = result.data as Record<string, unknown>;
            return data ? resolveTranslatableRow(data, entity, locale) : data;
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
        meta: {
          type: GraphQLString,
          description: "JSON-encoded execution meta (Spec 65 §3.2)",
        },
      },
      resolve: hasDispatcher
        ? async (_root: unknown, args: { id: string; meta?: string }, ctx: GraphQLContext) => {
            const meta = args.meta ? safeParseJSON(args.meta, "meta") : undefined;
            const result = await dispatchAction(`delete_${entityName}`, { id: args.id }, ctx, {
              meta,
            });
            if (result.success) invalidateEntityCache(entityName);
            return result.success;
          }
        : () => true,
    };

    // ── Mutation: restore (clear soft delete) ───────────────
    mutationFields[`restore${pascalName}`] = {
      type: objectType,
      args: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        meta: {
          type: GraphQLString,
          description: "JSON-encoded execution meta (Spec 65 §3.2)",
        },
      },
      resolve: hasDispatcher
        ? async (_root: unknown, args: { id: string; meta?: string }, ctx: GraphQLContext) => {
            const locale = ctx.locale;
            const meta = args.meta ? safeParseJSON(args.meta, "meta") : undefined;
            const result = await dispatchAction(`restore_${entityName}`, { id: args.id }, ctx, {
              includeDeleted: true,
              meta,
            });
            if (!result.success) {
              const errData = result.data as Record<string, unknown> | undefined;
              throw new GraphQLError(
                (errData?.error as string) ?? `Failed to restore ${entityName} id=${args.id}`,
              );
            }
            invalidateEntityCache(entityName);
            const data = result.data as Record<string, unknown>;
            return data ? resolveTranslatableRow(data, entity, locale) : data;
          }
        : () => null,
    };

    // ── State transition query + mutation ──────────────────
    // For each state field, find the associated state machine and generate
    // availableTransitions query and transition mutation.
    const stateFields = Object.entries(entity.fields).filter(([, f]) => f.type === "state");
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
                const record = await dataProvider.get(entityName, args.id, optsOrUndefined);
                if (!record) return [];
                const currentState =
                  (record[stateFieldName] as string) ?? machine.definition.initial ?? "";
                const transitions = getAvailableTransitions(machine, currentState);
                // Enrich each transition with permission pre-check from action definitions
                return transitions.map((tr) => {
                  const actor = ctx.actor;
                  // Check both transition action and update action permissions
                  const actionNames = [tr.action, `update_${entityName}`];
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
        description: `Transition ${entity.label ?? entityName} to a new state`,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          to: { type: new GraphQLNonNull(GraphQLString) },
          meta: {
            type: GraphQLString,
            description: "JSON-encoded execution meta (Spec 65 §3.2)",
          },
        },
        resolve:
          executor && dataProvider
            ? async (
                _root: unknown,
                args: { id: string; to: string; meta?: string },
                ctx: GraphQLContext,
              ) => {
                const opts: DataQueryOptions = {
                  ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
                };
                const optsOrUndefined = Object.keys(opts).length > 0 ? opts : undefined;

                // Fetch current record to get current state
                let record: Record<string, unknown>;
                try {
                  record = await dataProvider.get(entityName, args.id, optsOrUndefined);
                } catch {
                  // DataProvider.get threw (record missing or DB error) — surface as GraphQL error
                  throw new GraphQLError(`Record "${args.id}" not found in "${entityName}"`);
                }
                if (!record) {
                  throw new GraphQLError(`Record "${args.id}" not found in "${entityName}"`);
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
                const meta = args.meta ? safeParseJSON(args.meta, "meta") : undefined;
                const result = await dispatchAction(`update_${entityName}`, input, ctx, { meta });
                if (!result.success) {
                  const errData = result.data as Record<string, unknown> | undefined;
                  throw new GraphQLError((errData?.error as string) ?? `State transition failed`);
                }
                invalidateEntityCache(entityName);
                const data = result.data as Record<string, unknown>;
                return data ? resolveTranslatableRow(data, entity, ctx.locale) : data;
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
      action.entity && entityObjectTypes.has(action.entity)
        ? (entityObjectTypes.get(action.entity) ?? ActionResultType)
        : ActionResultType;
    const returnsSchemaType = returnType !== ActionResultType;

    // Build args: always include id (ID!), optionally include typed input,
    // always include `meta` (Spec 65 §3.2 — JSON-encoded execution meta).
    const args: Record<string, unknown> = {
      id: { type: new GraphQLNonNull(GraphQLID) },
      meta: {
        type: GraphQLString,
        description: "JSON-encoded execution meta (Spec 65 §3.2)",
      },
    };
    if (actionInputType) {
      args.input = { type: new GraphQLNonNull(actionInputType) };
    }

    // Capture the schema definition for translatable resolution in custom actions
    const actionEntity = action.entity ? entities.find((s) => s.name === action.entity) : undefined;

    mutationFields[mutationName] = {
      type: returnType,
      description: action.description ?? action.label,
      args,
      resolve: hasDispatcher
        ? async (
            _root: unknown,
            resolverArgs: { id: string; input?: Record<string, unknown>; meta?: string },
            ctx: GraphQLContext,
          ) => {
            const locale = ctx.locale;
            // Spread input first so explicit id argument takes precedence
            const input: Record<string, unknown> = {
              ...resolverArgs.input,
              id: resolverArgs.id,
            };
            const meta = resolverArgs.meta ? safeParseJSON(resolverArgs.meta, "meta") : undefined;
            const result = await dispatchAction(actionName, input, ctx, { meta });
            if (returnsSchemaType) {
              if (!result.success) {
                const errData = result.data as Record<string, unknown> | undefined;
                throw new Error((errData?.error as string) ?? `Action "${actionName}" failed`);
              }
              const data = result.data as Record<string, unknown>;
              return data && actionEntity
                ? resolveTranslatableRow(data, actionEntity, locale)
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
      meta: {
        type: GraphQLString,
        description: "JSON-encoded execution meta (Spec 65 §3.2)",
      },
    },
    resolve: hasDispatcher
      ? async (
          _root: unknown,
          args: { name: string; input: string; meta?: string },
          ctx: GraphQLContext,
        ) => {
          const input = safeParseJSON(args.input, "input") as Record<string, unknown>;
          const meta = args.meta ? safeParseJSON(args.meta, "meta") : undefined;
          const result = await dispatchAction(args.name, input, ctx, { meta });
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

  // Auto-generate `<entity>_onchange` mutations for entities with an
  // onchange map (Spec 64 §4.2). Skipped when CommandLayer or evaluator
  // is missing — keeps test setups that don't wire either from breaking.
  // `internalSchemas` is passed through so internal/system schemas with an
  // onchange map don't leak a public mutation (Codex Round-3 P3).
  const onchangeFields = buildOnchangeMutationFields(autoEntities, {
    commandLayer,
    onchangeEvaluator: options?.onchangeEvaluator,
    internalSchemas,
  });
  Object.assign(mutationFields, onchangeFields);

  // Merge capability-contributed GraphQL fields (Spec 57 graphqlExtensions)
  if (options?.extraQueryFields) {
    Object.assign(queryFields, options.extraQueryFields);
  }
  if (options?.extraMutationFields) {
    Object.assign(mutationFields, options.extraMutationFields);
  }

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
      entities,
      entityObjectTypes,
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
function buildMockRecord(entity: EntityDefinition): Record<string, unknown> {
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
  for (const [fieldName, field] of Object.entries(entity.fields)) {
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
