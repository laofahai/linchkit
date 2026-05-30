/**
 * Schema assembly — the server-free core of the dev/boot path.
 *
 * `dev.ts` was previously a single top-level script that inlined the entire
 * "capabilities → runtime context → GraphQLSchema" assembly. Because nothing
 * exercised that exact assembly outside of actually starting the HTTP server,
 * a regression (a deep-clone in `resolveEnvVars` flattening graphql type
 * instances carried in `graphqlExtensions`) shipped undetected and crashed
 * `bun run dev:server` at boot with "One of the provided types for building
 * the Schema is missing a name."
 *
 * This module extracts that assembly into a reusable, exported, DB-free and
 * server-free helper so it can be unit-tested with the real configured
 * capabilities. `dev.ts` now calls `assembleDevSchema(...)`.
 */

import type {
  ActionDefinition,
  AIService,
  CapabilityDefinition,
  EntityDefinition,
  MiddlewareRegistration,
  RelationDefinition,
  RuleDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";
import { createOnchangeEvaluator } from "@linchkit/core/server";
import type { GraphQLFieldConfig, GraphQLSchema } from "graphql";
import { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
import { createRuntimeContext, type RuntimeContext } from "./runtime-context";

/**
 * Merge a capability's contributed GraphQL fields into the shared bucket,
 * throwing on a name collision instead of silently overwriting.
 *
 * Two capabilities contributing the same root query/mutation field name would
 * otherwise have the later one silently win — a hard-to-debug runtime surprise.
 * Fail loud at assembly time with the offending capability and field named.
 */
function mergeGraphQLFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  kind: "query" | "mutation",
  capName: string,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(target, key)) {
      throw new Error(
        `Duplicate GraphQL ${kind} field "${key}" contributed by capability "${capName}" — ` +
          "another capability already registered a field with this name.",
      );
    }
    target[key] = value;
  }
}

/** Flattened contributions collected across all loaded capabilities. */
export interface CapabilityContributions {
  entities: EntityDefinition[];
  actions: ActionDefinition[];
  states: StateDefinition[];
  views: ViewDefinition[];
  relations: RelationDefinition[];
  rules: RuleDefinition[];
  middlewares: MiddlewareRegistration[];
  seed: Record<string, Array<Record<string, unknown>>>;
  extraQueryFields: Record<string, unknown>;
  extraMutationFields: Record<string, unknown>;
}

/**
 * Flatten every capability's contributions into a single bucket.
 *
 * This is the same extraction `dev.ts` performed inline.
 */
export function extractCapabilities(
  capabilities: CapabilityDefinition[] = [],
): CapabilityContributions {
  const entities: EntityDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const states: StateDefinition[] = [];
  const views: ViewDefinition[] = [];
  const relations: RelationDefinition[] = [];
  const rules: RuleDefinition[] = [];
  const middlewares: MiddlewareRegistration[] = [];
  const seed: Record<string, Array<Record<string, unknown>>> = {};
  const extraQueryFields: Record<string, unknown> = {};
  const extraMutationFields: Record<string, unknown> = {};

  for (const cap of capabilities) {
    if (cap.entities) entities.push(...cap.entities);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.states) states.push(...cap.states);
    if (cap.views) views.push(...cap.views);
    if (cap.relations) relations.push(...cap.relations);
    if (cap.rules) rules.push(...cap.rules);

    if (cap.seed) {
      for (const [entityName, records] of Object.entries(cap.seed)) {
        if (!seed[entityName]) seed[entityName] = [];
        seed[entityName].push(...records);
      }
    }

    if (cap.extensions?.middlewares) {
      for (const mw of cap.extensions.middlewares) {
        middlewares.push({
          name: `${cap.name}:${mw.slot}`,
          slot: mw.slot,
          order: mw.priority ?? 100,
          handler: mw.handler,
        });
      }
    }
    if (cap.extensions?.graphqlExtensions?.queryFields) {
      mergeGraphQLFields(
        extraQueryFields,
        cap.extensions.graphqlExtensions.queryFields,
        "query",
        cap.name,
      );
    }
    if (cap.extensions?.graphqlExtensions?.mutationFields) {
      mergeGraphQLFields(
        extraMutationFields,
        cap.extensions.graphqlExtensions.mutationFields,
        "mutation",
        cap.name,
      );
    }
  }

  return {
    entities,
    actions,
    states,
    views,
    relations,
    rules,
    middlewares,
    seed,
    extraQueryFields,
    extraMutationFields,
  };
}

export interface AssembleDevSchemaOptions {
  /** Optional AI service (built from config). Defaults to the noop service. */
  aiService?: AIService;
}

export interface AssembledDevSchema {
  schema: GraphQLSchema;
  runtime: RuntimeContext;
  contributions: CapabilityContributions;
  allEntities: EntityDefinition[];
  allActions: ActionDefinition[];
  onchangeEvaluator: ReturnType<typeof createOnchangeEvaluator>;
}

/**
 * Assemble the full dev GraphQL schema from a set of capabilities — the exact
 * path `bun run dev:server` exercises, minus starting the HTTP server.
 *
 * DB-free: `createRuntimeContext` falls back to `InMemoryStore` when no
 * `dataProvider` is supplied, so this runs in CI without Postgres.
 *
 * The returned `schema` is built with the FULL production shape — a real
 * `commandLayer` and `onchangeEvaluator`, all entities/actions/relations/
 * states, and capability-contributed `extraQueryFields`/`extraMutationFields`
 * — not the simplified shape unit tests typically use.
 */
export function assembleDevSchema(
  capabilities: CapabilityDefinition[],
  options?: AssembleDevSchemaOptions,
): AssembledDevSchema {
  const contributions = extractCapabilities(capabilities);

  // Dev-only allow-all permission stub. The CommandLayer hard-fails when the
  // `permission` slot is empty, so inject a low-priority pass-through unless a
  // capability already registered a permission middleware.
  const hasPermissionMiddleware = contributions.middlewares.some((mw) => mw.slot === "permission");
  if (!hasPermissionMiddleware) {
    contributions.middlewares.push({
      name: "dev:allow_all_permission",
      slot: "permission",
      order: 999,
      handler: async (_ctx, next) => {
        await next();
      },
    });
  }

  const allEntities = contributions.entities;

  // Generate CRUD actions, skipping any name a capability already defined.
  const capActionNames = new Set(contributions.actions.map((a) => a.name));
  const crudActions = allEntities
    .flatMap((entity) => generateCrudActions(entity))
    .filter((crud) => !capActionNames.has(crud.name));
  const allActions: ActionDefinition[] = [...crudActions, ...contributions.actions];

  const capabilityNames = new Set(capabilities.map((c) => c.name));

  const runtime = createRuntimeContext({
    entities: allEntities,
    actions: allActions,
    states: contributions.states,
    views: contributions.views,
    middlewares: contributions.middlewares,
    ai: options?.aiService,
    capabilityNames,
  });

  const onchangeEvaluator = createOnchangeEvaluator({
    entityRegistry: runtime.entityRegistry,
    dataProvider: runtime.dataProvider,
  });

  const schema = buildGraphQLSchema(allEntities, {
    executor: runtime.executor,
    commandLayer: runtime.commandLayer,
    dataProvider: runtime.dataProvider,
    actions: contributions.actions,
    relations: contributions.relations,
    stateDefinitions: contributions.states,
    onchangeEvaluator,
    extraQueryFields: contributions.extraQueryFields as Record<
      string,
      GraphQLFieldConfig<unknown, unknown>
    >,
    extraMutationFields: contributions.extraMutationFields as Record<
      string,
      GraphQLFieldConfig<unknown, unknown>
    >,
  });

  return { schema, runtime, contributions, allEntities, allActions, onchangeEvaluator };
}
