/**
 * Dev app factory — the server-bridge half of the dev/boot path.
 *
 * `assemble-schema.ts` builds the GraphQL schema + runtime context but stays
 * deliberately server-free. `dev.ts` then inlines the bridge that hands that
 * runtime to `createServer(...)` and binds a port. Because nothing exercised
 * THAT bridge outside of actually starting the listening HTTP server, an HTTP
 * wiring regression (e.g. a route module crashing on the in-memory runtime, or
 * `createServer` mis-wiring `entityRegistry`/`dataProvider`) could ship
 * undetected and only surface at `bun run dev:server`.
 *
 * This module extracts that bridge into a reusable, exported, DB-free and
 * port-free factory: `createDevApp(capabilities, options?)` returns a ready
 * Elysia app whose requests can be dispatched in-process via
 * `app.handle(new Request(...))` — no `listen()`, no socket, no Postgres.
 *
 * It mirrors `dev.ts`'s `createServer(...)` call exactly (same option mapping)
 * so the boot smoke test and the real dev server share one wiring path.
 */

import type { CapabilityDefinition, OntologyRegistry } from "@linchkit/core";
import {
  createFlowRegistry,
  createOntologyRegistry,
  createRelationRegistry,
} from "@linchkit/core/server";
import {
  type AssembleDevSchemaOptions,
  type AssembledDevSchema,
  assembleDevSchema,
} from "./assemble-schema";
import { createServer, type ServerOptions } from "./server";

/**
 * Options for {@link createDevApp}.
 *
 * Beyond the AI service used during assembly, any `ServerOptions` field is
 * accepted and forwarded to `createServer` — so advanced integration tests can
 * configure CORS, actor/tenant resolvers, an event bus, subscription config,
 * etc. The fields this factory derives from the assembled runtime (executor,
 * commandLayer, registries, dataProvider, …) are excluded: callers must not
 * override them.
 */
export interface CreateDevAppOptions
  extends AssembleDevSchemaOptions,
    Partial<
      Omit<
        ServerOptions,
        | "executor"
        | "commandLayer"
        | "approvalEngine"
        | "executionLogger"
        | "entityRegistry"
        | "views"
        | "capabilities"
        | "rules"
        | "aiService"
        | "states"
        | "flows"
        | "eventBus"
        | "dataProvider"
        | "onchangeEvaluator"
        | "ontologyRegistry"
      >
    > {}

/**
 * Build the unified OntologyRegistry over an assembled dev schema.
 *
 * Mirrors the `linch dev` boot path's `createOntologyRegistry({...})` call
 * (packages/cli/src/commands/dev-wiring.ts) so the dev-server entry exposes
 * the same semantic layer. Without it, ontology-dependent endpoints (e.g.
 * `POST /api/ai/resolve-schema-intent`) answer 503 "Ontology registry is not
 * available" and Phase 3 compatibility validation silently skips.
 *
 * Inputs reuse what the assembly already has in scope: the runtime's
 * EntityRegistry + the executor's ActionRegistry, plus the flattened
 * capability contributions (rules/states/views). Relation and flow registries
 * are built here from the contributed definitions — registration mirrors the
 * CLI's build-registries.ts, so an invalid relation fails loud at boot on
 * both paths. `handlers`/`interfaces` registries are not assembled on this
 * DB-free path; both deps are optional and omitted.
 */
export function buildDevOntologyRegistry(
  assembled: Pick<AssembledDevSchema, "runtime" | "contributions">,
): OntologyRegistry {
  const { runtime, contributions } = assembled;

  const relationRegistry = createRelationRegistry();
  for (const relation of contributions.relations) {
    relationRegistry.register(relation);
  }

  const flowRegistry = createFlowRegistry();
  for (const flow of contributions.flows) {
    flowRegistry.register(flow);
  }

  return createOntologyRegistry({
    schemas: runtime.entityRegistry,
    actions: runtime.executor.registry,
    rules: contributions.rules,
    states: contributions.states,
    views: contributions.views,
    links: relationRegistry,
    flows: flowRegistry,
    // Raw relation definitions feed the dependency graph / impact analysis
    // (Spec 67); `links` above only serves relation lookups.
    relationDefs: contributions.relations,
  });
}

/** Result of {@link createDevApp}: the Elysia app plus the assembled schema. */
export interface DevApp {
  /**
   * The Elysia app. Use `await app.handle(new Request(url, init))` to dispatch
   * requests in-process without binding a port, or `app.listen(port)` to serve.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Elysia plugin chaining produces complex inferred types — `createServer` returns `any` for the same reason.
  app: any;
  /** The assembled schema + runtime context that backs the app. */
  assembled: AssembledDevSchema;
}

/**
 * Build a ready-to-serve dev Elysia app from a set of capabilities.
 *
 * This is the exact path `bun run dev:server` exercises — `assembleDevSchema`
 * then `createServer` with the runtime wired in — minus loading config and
 * binding a port. DB-free: with no `dataProvider`, `assembleDevSchema` falls
 * back to `InMemoryStore`, so this runs in CI without Postgres.
 *
 * @param capabilities - Capabilities to assemble (adapter + business + system).
 * @param options - AI service used during assembly, plus any `ServerOptions`
 *   field (cors, actor/tenant resolvers, event bus, …) to forward to the server.
 * @returns The Elysia app and the assembled schema/runtime that backs it.
 */
export function createDevApp(
  capabilities: CapabilityDefinition[],
  options?: CreateDevAppOptions,
): DevApp {
  // `aiService` is consumed by the assembly; everything else is a ServerOptions
  // passthrough forwarded to `createServer`.
  const { aiService, ...serverOverrides } = options ?? {};
  const assembled = assembleDevSchema(capabilities, { aiService });
  const { schema, runtime, contributions, onchangeEvaluator } = assembled;

  // Unified semantic layer — same construction as dev.ts and the `linch dev`
  // boot path, so ontology-dependent routes work on the in-process app too.
  const ontologyRegistry = buildDevOntologyRegistry(assembled);

  // Forward caller-supplied ServerOptions first, then the fields this factory
  // derives from the assembled runtime — which always win (and are excluded
  // from CreateDevAppOptions so callers cannot override them). This mirrors
  // dev.ts's createServer(...) call so the smoke test and the real dev server
  // share one wiring path.
  const app = createServer(schema, {
    ...serverOverrides,
    executor: runtime.executor,
    commandLayer: runtime.commandLayer,
    approvalEngine: runtime.approvalEngine,
    executionLogger: runtime.executionLogger,
    entityRegistry: runtime.entityRegistry,
    views: runtime.views,
    capabilities,
    rules: contributions.rules,
    aiService: runtime.ai,
    states: contributions.states,
    // Flow admin endpoints (/api/flows) stay out of the in-process path, mirroring
    // dev.ts — only the real `linch dev` boot path (http-transport) exposes them
    // with a flowEngine. `trigger_flow` rule effects do NOT need this: their flow
    // engine is wired onto the executor inside createRuntimeContext (from the
    // aggregated capability flows), independent of this server-introspection arg.
    flows: [],
    // Event bus assembled in createRuntimeContext — forwarded so the SSE
    // subscription route (`/api/subscribe`) mounts and domain events reach
    // subscribers. Without it, `mountSubscriptionRoutes` early-returns and the
    // route is dead.
    eventBus: runtime.eventBus,
    dataProvider: runtime.dataProvider,
    onchangeEvaluator,
    ontologyRegistry,
  });

  return { app, assembled };
}
