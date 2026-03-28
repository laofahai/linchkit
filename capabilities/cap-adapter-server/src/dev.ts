/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Loads linchkit.config.ts, then starts the LinchKit server
 * with capabilities from config. No hardcoded demo data.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  LinkDefinition,
  MiddlewareRegistration,
  RuleDefinition,
  SchemaDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config-loader";
import { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
import { createRuntimeContext } from "./runtime-context";
import { createServer } from "./server";

// ── Resolve project root ────────────────────────────────
// When run via `bun run --filter` in a workspace, CWD is the package
// directory (e.g. capabilities/cap-adapter-server/), not the project
// root. Walk up from this file's directory to find the workspace root
// that contains the config/ folder.

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    // Check for config/linchkit.config.ts or linchkit.config.ts
    if (
      existsSync(resolve(dir, "config", "linchkit.config.ts")) ||
      existsSync(resolve(dir, "linchkit.config.ts"))
    ) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return startDir; // fallback to original dir
}

const projectRoot = findProjectRoot(resolve(import.meta.dir, "../../.."));

// ── Load .env file if present ────────────────────────────
// Must happen BEFORE loadConfig() so that $env.VAR_NAME placeholders
// in linchkit.config.ts can resolve to actual environment variable values.
const envPath = resolve(projectRoot, ".env");
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log("[linchkit] Loaded .env file");
}

// ── Load configuration ──────────────────────────────────

const config = await loadConfig({ root: projectRoot });

// ── Extract capability contributions ────────────────────

function extractCapabilities(capabilities: CapabilityDefinition[] = []): {
  schemas: SchemaDefinition[];
  actions: ActionDefinition[];
  states: StateDefinition[];
  views: ViewDefinition[];
  links: LinkDefinition[];
  rules: RuleDefinition[];
  middlewares: MiddlewareRegistration[];
  seed: Record<string, Array<Record<string, unknown>>>;
} {
  const schemas: SchemaDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const states: StateDefinition[] = [];
  const views: ViewDefinition[] = [];
  const links: LinkDefinition[] = [];
  const rules: RuleDefinition[] = [];
  const middlewares: MiddlewareRegistration[] = [];
  const seed: Record<string, Array<Record<string, unknown>>> = {};

  for (const cap of capabilities) {
    if (cap.schemas) schemas.push(...cap.schemas);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.states) states.push(...cap.states);
    if (cap.views) views.push(...cap.views);
    if (cap.links) links.push(...cap.links);
    if (cap.rules) rules.push(...cap.rules);

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

  return { schemas, actions, states, views, links, rules, middlewares, seed };
}

const capContributions = extractCapabilities(config.capabilities);

// ── Merge capability schemas and actions ────────────────

const allSchemas = capContributions.schemas;

// Generate CRUD actions, skip if capability already defined one with same name
const capActionNames = new Set(capContributions.actions.map((a) => a.name));
const crudActions = allSchemas
  .flatMap((s) => generateCrudActions(s))
  .filter((crud) => !capActionNames.has(crud.name));

const allActions: ActionDefinition[] = [...crudActions, ...capContributions.actions];

// ── Initialize runtime context ──────────────────────────

// Build capability name set for ctx.hasCapability() weak dependency checks
const capabilityNames = new Set((config.capabilities ?? []).map((c) => c.name));

const runtime = createRuntimeContext({
  schemas: allSchemas,
  actions: allActions,
  states: capContributions.states,
  views: capContributions.views,
  middlewares: capContributions.middlewares,
  ai: config.ai,
  capabilityNames,
});

// Seed dev data from capabilities (only works with InMemoryStore)
const { InMemoryStore } = await import("@linchkit/core/server");
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
  links: capContributions.links,
  stateDefinitions: capContributions.states,
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
  capabilities: config.capabilities,
  rules: capContributions.rules,
  aiService: runtime.ai,
  linchKitConfig: config,
  states: capContributions.states,
  flows: [],
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
