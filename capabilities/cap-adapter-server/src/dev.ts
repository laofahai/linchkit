/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Loads linchkit.config.ts, then starts the LinchKit server
 * with capabilities from config. No hardcoded demo data.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  MiddlewareRegistration,
  SchemaDefinition,
  ViewDefinition,
} from "@linchkit/core";
import { loadConfig } from "./config-loader";
import { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
import { createRuntimeContext } from "./runtime-context";
import { createServer } from "./server";

// ── Load configuration ──────────────────────────────────

const config = await loadConfig();

// ── Extract capability contributions ────────────────────

function extractCapabilities(capabilities: CapabilityDefinition[] = []): {
  schemas: SchemaDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  middlewares: MiddlewareRegistration[];
  seed: Record<string, Array<Record<string, unknown>>>;
} {
  const schemas: SchemaDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const views: ViewDefinition[] = [];
  const middlewares: MiddlewareRegistration[] = [];
  const seed: Record<string, Array<Record<string, unknown>>> = {};

  for (const cap of capabilities) {
    if (cap.schemas) schemas.push(...cap.schemas);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.views) views.push(...cap.views);

    // Collect seed data from capabilities
    if (cap.seed) {
      for (const [schemaName, records] of Object.entries(cap.seed)) {
        if (!seed[schemaName]) seed[schemaName] = [];
        seed[schemaName].push(...records);
      }
    }

    // Convert CapabilityMiddlewareRegistration → MiddlewareRegistration
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
  }

  return { schemas, actions, views, middlewares, seed };
}

const capContributions = extractCapabilities(config.capabilities);

// ── Merge capability schemas and actions ────────────────

const allSchemas = capContributions.schemas;

// Generate CRUD actions, skip if capability already defined one with same name
const capActionNames = new Set(capContributions.actions.map((a) => a.name));
const crudActions = allSchemas
  .flatMap(generateCrudActions)
  .filter((crud) => !capActionNames.has(crud.name));

const allActions: ActionDefinition[] = [...crudActions, ...capContributions.actions];

// ── Initialize runtime context ──────────────────────────

const runtime = createRuntimeContext({
  schemas: allSchemas,
  actions: allActions,
  views: capContributions.views,
  middlewares: capContributions.middlewares,
  ai: config.ai,
});

// Seed dev data from capabilities (only works with InMemoryStore)
const { InMemoryStore } = await import("./data/in-memory-store");
if (runtime.dataProvider instanceof InMemoryStore) {
  for (const [schemaName, records] of Object.entries(capContributions.seed)) {
    runtime.dataProvider.seed(schemaName, records);
  }
}

// ── Build schema and start server ────────────────────────

const customActions = capContributions.actions;

const graphqlSchema = buildGraphQLSchema(allSchemas, {
  executor: runtime.executor,
  dataProvider: runtime.dataProvider,
  actions: customActions,
  executionLogger: runtime.executionLogger,
});

const port = config.server?.port ?? 3001;
const host = config.server?.host ?? "0.0.0.0";

const server = createServer(graphqlSchema, {
  port,
  host,
  executor: runtime.executor,
  commandLayer: runtime.commandLayer,
  executionLogger: runtime.executionLogger,
  schemaRegistry: runtime.schemaRegistry,
  views: runtime.views,
});

server.listen(port);

// ── Startup summary ──────────────────────────────────────

const aiSummary = config.ai
  ? `${config.ai.defaultProvider} (${Object.keys(config.ai.providers).join(", ")})`
  : "not configured";

console.log(`\nLinchKit Dev Server`);
console.log(`───────────────────────────────────`);
console.log(`  HTTP:       http://${host}:${port}`);
console.log(`  GraphQL:    http://${host}:${port}/graphql`);
console.log(`  Health:     http://${host}:${port}/health`);
console.log(`  REST API:   http://${host}:${port}/api/actions/:name`);
console.log(`  Exec Logs:  http://${host}:${port}/api/executions`);
console.log(`───────────────────────────────────`);
const capNames = (config.capabilities ?? []).map((c) => c.name).join(", ") || "none";
const mwCount = capContributions.middlewares.length;

console.log(`  Schemas:    ${allSchemas.length} (${allSchemas.map((s) => s.name).join(", ")})`);
console.log(`  Actions:    ${allActions.length} (${allActions.map((a) => a.name).join(", ")})`);
console.log(`  Views:      ${capContributions.views.length}`);
console.log(`  Caps:       ${capNames}`);
console.log(`  Middlewares: ${mwCount} registered`);
console.log(`  CmdLayer:   enabled`);
console.log(`  AI:         ${aiSummary}`);
console.log(`  Logger:     InMemoryExecutionLogger enabled`);
console.log(`───────────────────────────────────\n`);
