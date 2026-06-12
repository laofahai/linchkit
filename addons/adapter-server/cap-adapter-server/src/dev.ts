/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Loads linchkit.config.ts, then starts the LinchKit server
 * with capabilities from config. No hardcoded demo data.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { consoleLogger } from "@linchkit/core/server";
import { assembleDevSchema } from "./assemble-schema";
import { loadConfig } from "./config-loader";
import { resolveDevRoleActor } from "./dev-actor-resolver";
import { buildDevEvolutionRuntime, buildDevOntologyRegistry } from "./dev-app";
import { createServer } from "./server";
import { startDevTransports } from "./start-dev-transports";
import { wireAITraceSink } from "./wire-ai-trace-sink";

// ── Resolve project root ────────────────────────────────
// When run via `bun run --filter` in a workspace, CWD is the package
// directory (e.g. addons/adapter-server/cap-adapter-server/), not the project
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

const projectRoot = findProjectRoot(process.cwd());

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

// ── Build AI service from config ─────────────────────────
// Requires @linchkit/cap-ai-provider only when AI is configured.
let aiService: import("@linchkit/core").AIService | undefined;
if (config.ai) {
  const { createAIService } = await import("@linchkit/cap-ai-provider");
  aiService = createAIService(config.ai);
}

// ── Assemble the schema (server-free, DB-free core) ──────
// `assembleDevSchema` is the shared, exported helper that both this dev entry
// point AND the boot smoke test exercise — so a regression that breaks schema
// assembly (e.g. graphql types in graphqlExtensions getting clobbered) is
// caught by CI instead of only at `bun run dev:server`.
const assembled = assembleDevSchema(config.capabilities ?? [], { aiService });
const {
  schema: graphqlSchema,
  runtime,
  contributions: capContributions,
  onchangeEvaluator,
} = assembled;

// `assembleDevSchema` injects a named allow-all stub when no capability
// supplied a permission middleware — surface that to the operator.
const usingPermissionStub = capContributions.middlewares.some(
  (mw) => mw.name === "dev:allow_all_permission",
);
if (usingPermissionStub) {
  consoleLogger.warn(
    "[permission] no permission middleware registered — dev server is running with an allow-all stub. Register cap-permission (or an equivalent) before deploying to production.",
  );
}
consoleLogger.warn(
  "[onchange] no checkReadPermission configured — lookup/query helpers return data without permission enforcement. Wire cap-permission (or an equivalent) to gate entity reads inside onchange hooks.",
);

// Seed dev data from capabilities (only works with InMemoryStore)
const { InMemoryStore } = await import("@linchkit/core/server");
if (runtime.dataProvider instanceof InMemoryStore) {
  for (const [entityName, records] of Object.entries(capContributions.seed)) {
    runtime.dataProvider.seed(entityName, records);
  }
}

const allEntities = assembled.allEntities;
const allActions = assembled.allActions;

// Unified semantic layer over the assembled registries — mirrors the
// `linch dev` boot path (dev-wiring.ts). Without it, ontology-dependent
// endpoints (e.g. POST /api/ai/resolve-schema-intent) answer 503 and Phase 3
// compatibility validation silently skips.
const ontologyRegistry = buildDevOntologyRegistry(assembled);
consoleLogger.info(`OntologyRegistry built (${ontologyRegistry.listEntities().length} schemas)`);

// Evolution runtime (Spec 55) — mirrors the `linch dev` boot path
// (dev-wiring.ts). Without it, POST /api/evolution/run-cycle answers 501
// "Evolution runtime is not configured" and the Evolution page's
// "Run Evolution Cycle" button dead-ends. SAFETY: proposals from the live
// cycle stay DATA-only drafts — no graduation, no file writes, no scheduler.
const evolutionRuntime = buildDevEvolutionRuntime({
  capabilities: config.capabilities ?? [],
  assembled,
  ontologyRegistry,
});
consoleLogger.info(
  `Evolution runtime ready: ${evolutionRuntime.signalBus.listSensors().length} sensor(s) registered ` +
    "(insight→proposal translator + pre-analysis pipeline wired)",
);

// AI trace sink (Spec 69 P3 wave 2) — register a LIVE sink so the AI
// instrumentation's `getAITraceSink().recordGeneration(...)` calls are actually
// persisted instead of discarded by the Noop default. DB mode → DrizzleAITraceStore
// (durable PG mirror); no DATABASE_URL → InMemoryAITraceStore (in-process only).
// Non-throwing: a wiring failure logs + leaves the prior sink in place, never
// crashing boot. On the dev path the dataProvider is the in-memory store unless a
// DATABASE_URL-backed provider was injected, so this is InMemory here by default.
await wireAITraceSink({ dataProvider: runtime.dataProvider });

const port = config.server?.port ?? 3001;
const host = config.server?.host ?? "0.0.0.0";

const server = createServer(graphqlSchema, {
  port,
  host,
  executor: runtime.executor,
  commandLayer: runtime.commandLayer,
  approvalEngine: runtime.approvalEngine,
  executionLogger: runtime.executionLogger,
  entityRegistry: runtime.entityRegistry,
  views: runtime.views,
  capabilities: config.capabilities,
  rules: capContributions.rules,
  aiService: runtime.ai,
  // The assistant + model-resolving AI routes gate on BOTH aiService AND
  // aiConfig (ai-api.ts) — without this the boot summary says "AI: zhipu"
  // while POST /api/ai/assistant answers 503 "AI service is not configured".
  aiConfig: config.ai,
  linchKitConfig: config,
  states: capContributions.states,
  flows: [],
  // Dev-only role switching (`x-dev-role` header) — a development affordance,
  // NOT an auth mechanism. Lives in this dev entry wiring only; absent or
  // unrecognized header resolves to the same elevated no-auth actor as before,
  // so every existing channel (REST scripts, flows, AI endpoints) is unchanged.
  resolveRequestActor: resolveDevRoleActor,
  dataProvider: runtime.dataProvider,
  onchangeEvaluator,
  ontologyRegistry,
  evolutionRuntime,
});

server.listen(port);

// ── Start non-HTTP transports (e.g. MCP) ─────────────────
// The HTTP/GraphQL server above is the `http` transport, started directly.
// Every OTHER transport a capability contributes through the generic
// `extensions.transports` seam (e.g. cap-adapter-mcp's SSE transport on :3002
// in the purchase demo config) is started here — mirroring the `linch dev` CLI
// path — so the MCP channel is reachable out of the box without a hard runtime
// import of cap-adapter-mcp (#573). Non-throwing per-transport: a failure is
// logged and skipped so the HTTP server (already listening) stays up.
const transportLifecycles = await startDevTransports({
  config,
  capabilities: config.capabilities ?? [],
  assembled,
  ontologyRegistry,
  evolutionRuntime,
});

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
if (transportLifecycles.length > 0) {
  console.log(`  Transports: ${transportLifecycles.length} extra started (e.g. MCP)`);
}
console.log(`───────────────────────────────────`);
const capNames = (config.capabilities ?? []).map((c) => c.name).join(", ") || "none";
const mwCount = capContributions.middlewares.length;

console.log(`  Schemas:    ${allEntities.length} (${allEntities.map((s) => s.name).join(", ")})`);
console.log(`  Actions:    ${allActions.length} (${allActions.map((a) => a.name).join(", ")})`);
console.log(`  Views:      ${capContributions.views.length}`);
console.log(`  Caps:       ${capNames}`);
console.log(`  Middlewares: ${mwCount} registered`);
console.log(`  CmdLayer:   enabled`);
console.log(`  AI:         ${aiSummary}`);
console.log(`  Logger:     InMemoryExecutionLogger enabled`);
console.log(`───────────────────────────────────\n`);
