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
import { ConfigRegistry, initI18n, VERSION } from "@linchkit/core";
import {
  closeDatabase,
  consoleLogger,
  detectEnvironment,
  enforceCoreCompatibility,
  GracefulShutdownManager,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import { generateCapabilityStylesheet } from "../utils/generate-capability-styles";
import { loadConfig, resolveActiveCapabilities } from "../utils/load-config";
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
      consoleLogger.info("Loaded .env file");
    }

    // ── Environment detection ──
    const environment = detectEnvironment();
    consoleLogger.info(
      `Environment: ${environment.name} (verbose=${environment.features.verboseLogging}, strictValidation=${environment.features.strictValidation})`,
    );

    consoleLogger.info("Loading configuration...");

    // Load project config
    let config: LinchKitConfig = {};
    try {
      const result = await loadConfig();
      config = result.config;
      consoleLogger.info(`Config loaded from ${result.configPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Config file not found:")) {
        consoleLogger.info("No config found, using defaults.");
      } else {
        consoleLogger.error(`Failed to load config: ${msg}`, {
          error: err instanceof Error ? err.stack : undefined,
        });
        process.exit(1);
      }
    }

    // Resolve active capabilities (config + addons_path discovery, deps + auto-install)
    let capabilities: CapabilityDefinition[];
    try {
      capabilities = await resolveActiveCapabilities(config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      consoleLogger.error(`Failed to resolve capabilities: ${msg}`, {
        error: err instanceof Error ? err.stack : undefined,
      });
      process.exit(1);
    }

    // ── Core ↔ capability version-compatibility check (Spec 21 / #122) ──
    //
    // SAFETY: core `VERSION` is currently "0.0.1" while shipped addons declare
    // ranges like "^0.2.0", so strict-refuse would reject EVERY addon and break
    // dev boot. We therefore keep strict mode OFF (warn-only) for now.
    //
    // TODO(#122): once core `VERSION` is reconciled with addon `coreVersion`
    // declarations, allow strict enforcement to be driven by
    // `environment.features.strictValidation`. Until then strict stays forced
    // off regardless of environment so the boot path never refuses addons.
    const STRICT_COMPAT_READY = false; // flip when VERSION matches addon ranges
    const strictCompat = STRICT_COMPAT_READY && environment.features.strictValidation;
    enforceCoreCompatibility(capabilities, VERSION, {
      strict: strictCompat,
      logger: consoleLogger,
    });

    // ── Create ConfigRegistry (env resolution + Zod validation + freeze) ──
    let registry: ConfigRegistry;
    try {
      registry = ConfigRegistry.create(config, capabilities);
      consoleLogger.info(`ConfigRegistry created (namespaces: ${registry.keys().join(", ")})`);
    } catch (err) {
      // ConfigRegistry.create collects all validation errors and throws once
      const msg = err instanceof Error ? err.message : String(err);
      consoleLogger.error(`Configuration validation failed:\n\n${msg}`, {
        error: err instanceof Error ? err.stack : undefined,
      });
      process.exit(1);
    }

    // Generate capability stylesheet if UI adapter is present
    const generatedStylesheet = generateCapabilityStylesheet(capabilities);
    if (generatedStylesheet?.updated) {
      consoleLogger.info(`Generated capability stylesheet: ${generatedStylesheet.path}`);
    }

    // ── Initialize i18n before collecting (registerTranslations needs it) ──
    await initI18n();

    // ── Collect all definitions from capabilities ──
    const collected = collectCapabilityDefinitions(capabilities);
    const { entities, actions, views, states, links, rules, middlewares, transports } = collected;

    consoleLogger.info(
      `Loaded ${capabilities.length} capabilities, ${entities.length} schemas, ${actions.length} actions`,
    );
    consoleLogger.info(
      `Found ${transports.length} transport(s): ${transports.map((t) => t.name).join(", ") || "none"}`,
    );

    // ── Build registries (schema, action, link, interface, permission) + middleware wiring ──
    const {
      entityRegistry,
      actionRegistry,
      relationRegistry,
      interfaceRegistry,
      permissionRegistry,
    } = await buildRegistries({
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

    // ── Wire all runtime engines (executor, event bus, flows, etc.) ──
    const { transportCtx, restateEndpoint, outboxWorker } = await wireDevEngines({
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
      middlewares,
      capabilities,
      sensors: collected.sensors,
      dbInstance,
      dataProvider: devDataProvider,
      usingDatabase,
    });

    // Start all transports
    const lifecycles: TransportLifecycle[] = [];

    for (const transport of transports) {
      try {
        consoleLogger.info(`Starting transport: ${transport.label ?? transport.name}...`);
        const lifecycle = await transport.factory(transportCtx);
        await lifecycle.start();
        lifecycles.push(lifecycle);
        consoleLogger.info(`Transport ${transport.name} started.`);
      } catch (err) {
        const error = err as Error;
        consoleLogger.error(`Failed to start transport "${transport.name}": ${error.message}`, {
          error: error.stack,
        });
      }
    }

    if (lifecycles.length === 0) {
      consoleLogger.warn(
        "No transports started. Install adapter capabilities (e.g. @linchkit/cap-adapter-server).",
      );
    }

    // ── Graceful shutdown manager ──
    const shutdownManager = new GracefulShutdownManager({ timeoutMs: 15_000 });

    // Priority 10: drain transports (HTTP connections, etc.)
    for (const lc of lifecycles) {
      shutdownManager.register("transport", () => lc.stop(), 10);
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

    process.stdout.write("\n");
    consoleLogger.info("Dev server ready. Press Ctrl+C to stop.");
  },
});
