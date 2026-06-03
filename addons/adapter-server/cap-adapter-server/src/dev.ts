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
import { createServer } from "./server";

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
  linchKitConfig: config,
  states: capContributions.states,
  flows: [],
  dataProvider: runtime.dataProvider,
  onchangeEvaluator,
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

console.log(`  Schemas:    ${allEntities.length} (${allEntities.map((s) => s.name).join(", ")})`);
console.log(`  Actions:    ${allActions.length} (${allActions.map((a) => a.name).join(", ")})`);
console.log(`  Views:      ${capContributions.views.length}`);
console.log(`  Caps:       ${capNames}`);
console.log(`  Middlewares: ${mwCount} registered`);
console.log(`  CmdLayer:   enabled`);
console.log(`  AI:         ${aiSummary}`);
console.log(`  Logger:     InMemoryExecutionLogger enabled`);
console.log(`───────────────────────────────────\n`);
