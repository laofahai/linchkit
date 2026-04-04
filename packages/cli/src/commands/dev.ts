/**
 * linch dev — Start all LinchKit transports in development mode
 *
 * Loads linchkit.config.ts from the current directory,
 * extracts schemas/actions from capabilities, and starts
 * all transports declared via extensions.transports.
 *
 * CLI only depends on @linchkit/core — adapter packages provide
 * transport factories through the capability contract.
 */

import type { CapabilityDefinition, LinchKitConfig, TransportLifecycle } from "@linchkit/core";
import { ConfigRegistry } from "@linchkit/core";
import { closeDatabase, detectEnvironment, GracefulShutdownManager } from "@linchkit/core/server";
import { defineCommand } from "citty";
import { generateCapabilityStylesheet } from "../utils/generate-capability-styles";
import { loadConfig } from "../utils/load-config";
import { wireDevEngines } from "./dev-wiring";
import { buildRegistries, wireAuthProvider } from "./startup/build-registries";
import { collectCapabilityDefinitions } from "./startup/collect-capabilities";
import { setupDatabase } from "./startup/setup-database";

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Start all LinchKit transports in development mode",
  },
  args: {
    port: {
      type: "string",
      description: "Override port (default: 3001)",
      default: "3001",
    },
    host: {
      type: "string",
      description: "Override host (default: 0.0.0.0)",
      default: "0.0.0.0",
    },
  },
  async run({ args: _args }) {
    // ── Load .env file if present ──
    const { existsSync, readFileSync } = await import("node:fs");
    const envPath = `${process.cwd()}/.env`;
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
      console.log("[linch] Loaded .env file");
    }

    // ── Environment detection ──
    const environment = detectEnvironment();
    console.log(
      `[linch] Environment: ${environment.name} (verbose=${environment.features.verboseLogging}, strictValidation=${environment.features.strictValidation})`,
    );

    console.log("[linch] Loading configuration...");

    // Load project config
    let config: LinchKitConfig = {};
    try {
      const result = await loadConfig();
      config = result.config;
      console.log(`[linch] Config loaded from ${result.configPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Config file not found:")) {
        console.log("[linch] No config found, using defaults.");
      } else {
        console.error("[linch] Failed to load config:", msg);
        process.exit(1);
      }
    }

    // Extract from capabilities
    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];

    // ── Create ConfigRegistry (env resolution + Zod validation + freeze) ──
    let registry: ConfigRegistry;
    try {
      registry = ConfigRegistry.create(config, capabilities);
      console.log(`[linch] ConfigRegistry created (namespaces: ${registry.keys().join(", ")})`);
    } catch (err) {
      // ConfigRegistry.create collects all validation errors and throws once
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[linch] Configuration validation failed:\n\n${msg}`);
      process.exit(1);
    }

    // Generate capability stylesheet if UI adapter is present
    const generatedStylesheet = generateCapabilityStylesheet(capabilities);
    if (generatedStylesheet?.updated) {
      console.log(`[linch] Generated capability stylesheet: ${generatedStylesheet.path}`);
    }

    // ── Collect all definitions from capabilities ──
    const collected = collectCapabilityDefinitions(capabilities);
    const { entities, actions, views, states, links, rules, automations, middlewares, transports } =
      collected;

    console.log(
      `[linch] Loaded ${capabilities.length} capabilities, ${entities.length} schemas, ${actions.length} actions`,
    );
    console.log(
      `[linch] Found ${transports.length} transport(s): ${transports.map((t) => t.name).join(", ") || "none"}`,
    );

    // ── Build registries (schema, action, link, interface, permission) + middleware wiring ──
    const { entityRegistry, actionRegistry, relationRegistry, interfaceRegistry, permissionRegistry } =
      await buildRegistries({
        capabilities,
        interfaces: collected.interfaces,
        schemas: entities,
        actions,
        links,
        middlewares,
        registry,
        environment,
      });

    // ── Database setup ──
    const {
      dataProvider: devDataProvider,
      usingDatabase,
      dbInstance,
    } = await setupDatabase({
      registry,
      schemas: entities,
      links,
    });

    // ── Auth provider wiring ──
    await wireAuthProvider({
      capabilities,
      actionRegistry,
      actions,
      middlewares,
      dataProvider: devDataProvider,
      registry,
      usingDatabase,
      dbInstance,
    });

    // ── Wire all runtime engines (executor, event bus, flows, automation, etc.) ──
    const { transportCtx, restateEndpoint, outboxWorker, automationEngine, automationsStarted } =
      await wireDevEngines({
        config,
        registry,
        environment,
        entityRegistry,
        actionRegistry,
        relationRegistry,
        interfaceRegistry,
        permissionRegistry,
        entities,
        actions,
        views,
        states,
        links,
        rules,
        automations,
        middlewares,
        capabilities,
        dbInstance,
        dataProvider: devDataProvider,
        usingDatabase,
      });

    // Start all transports
    const lifecycles: TransportLifecycle[] = [];

    for (const transport of transports) {
      try {
        console.log(`[linch] Starting transport: ${transport.label ?? transport.name}...`);
        const lifecycle = await transport.factory(transportCtx);
        await lifecycle.start();
        lifecycles.push(lifecycle);
        console.log(`[linch] Transport ${transport.name} started.`);
      } catch (err) {
        const error = err as Error;
        console.error(`[linch] Failed to start transport "${transport.name}":`, error.message);
      }
    }

    if (lifecycles.length === 0) {
      console.log(
        "[linch] Warning: No transports started. Install adapter capabilities (e.g. @linchkit/cap-adapter-server).",
      );
    }

    // ── Graceful shutdown manager ──
    const shutdownManager = new GracefulShutdownManager({ timeoutMs: 15_000 });

    // Priority 10: drain transports (HTTP connections, etc.)
    for (const lc of lifecycles) {
      shutdownManager.register("transport", () => lc.stop(), 10);
    }

    // Priority 15: stop automation engine
    if (automationsStarted) {
      shutdownManager.register("automation-engine", () => automationEngine.stop(), 15);
    }

    // Priority 20: stop event bus + outbox worker
    shutdownManager.register(
      "event-bus",
      () => {
        // EventBus doesn't have an explicit stop — no-op placeholder for future use
      },
      20,
    );
    if (outboxWorker) {
      shutdownManager.register("outbox-worker", () => outboxWorker.stop(), 20);
    }

    // Priority 30: stop Restate endpoint
    if (restateEndpoint) {
      const endpoint = restateEndpoint;
      shutdownManager.register("restate-endpoint", () => endpoint.stop(), 30);
    }

    // Priority 90: close database connection (must be last)
    if (usingDatabase) {
      shutdownManager.register("database", () => closeDatabase(), 90);
    }

    shutdownManager.bindSignals();

    console.log("");
    console.log("[linch] Dev server ready. Press Ctrl+C to stop.");
  },
});
