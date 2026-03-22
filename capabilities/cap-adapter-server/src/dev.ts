/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Loads linchkit.config.ts, then starts the LinchKit server
 * with capabilities from config. No hardcoded demo data.
 */

import { purchaseRequestSeedData } from "@linchkit/cap-purchase-demo";
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
} {
  const schemas: SchemaDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const views: ViewDefinition[] = [];
  const middlewares: MiddlewareRegistration[] = [];

  for (const cap of capabilities) {
    if (cap.schemas) schemas.push(...cap.schemas);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.views) views.push(...cap.views);

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

  return { schemas, actions, views, middlewares };
}

const capContributions = extractCapabilities(config.capabilities);

// ── Merge capability schemas and actions ────────────────

const allSchemas = capContributions.schemas;

const allActions: ActionDefinition[] = [
  ...allSchemas.flatMap(generateCrudActions),
  ...capContributions.actions,
];

// ── Initialize runtime context ──────────────────────────

const runtime = createRuntimeContext({
  schemas: allSchemas,
  actions: allActions,
  views: capContributions.views,
  middlewares: capContributions.middlewares,
  ai: config.ai,
});

// Seed demo data (purchase request)
runtime.store.seed("purchase_request", purchaseRequestSeedData);

// ── Build schema and start server ────────────────────────

const customActions = capContributions.actions;

const graphqlSchema = buildGraphQLSchema(allSchemas, {
  executor: runtime.executor,
  store: runtime.store,
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
