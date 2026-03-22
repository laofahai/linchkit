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

import type {
  ActionDefinition,
  CapabilityDefinition,
  DataProvider,
  LinchKitConfig,
  MiddlewareRegistration,
  SchemaDefinition,
  StateDefinition,
  TransportAdapterDefinition,
  TransportContext,
  TransportLifecycle,
  ViewDefinition,
} from "@linchkit/core";
import {
  ActionRegistry,
  createActionExecutor,
  createCommandLayer,
  SchemaRegistry,
} from "@linchkit/core";
import { defineCommand } from "citty";
import { generateCapabilityStylesheet } from "../utils/generate-capability-styles";
import { loadConfig } from "../utils/load-config";

/** Minimal no-op DataProvider for dev mode bootstrap */
function createNoopDataProvider(): DataProvider {
  const notImpl = () => {
    throw new Error("No DataProvider configured. Transports should provide their own.");
  };
  return {
    get: notImpl,
    query: notImpl,
    create: notImpl,
    update: notImpl,
    delete: notImpl,
  };
}

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
    console.log("[linch] Loading configuration...");

    // Load project config
    let config: LinchKitConfig = {};
    try {
      const result = await loadConfig();
      config = result.config;
      console.log(`[linch] Config loaded from ${result.configPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Config file not found")) {
        console.log("[linch] No config found, using defaults.");
      } else {
        console.error("[linch] Failed to load config:", msg);
        process.exit(1);
      }
    }

    // Extract from capabilities
    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];

    // Generate capability stylesheet if UI adapter is present
    const generatedStylesheet = generateCapabilityStylesheet(capabilities);
    if (generatedStylesheet?.updated) {
      console.log(`[linch] Generated capability stylesheet: ${generatedStylesheet.path}`);
    }

    const schemas: SchemaDefinition[] = [];
    const actions: ActionDefinition[] = [];
    const views: ViewDefinition[] = [];
    const states: StateDefinition[] = [];
    const middlewares: MiddlewareRegistration[] = [];
    const transports: TransportAdapterDefinition[] = [];

    for (const cap of capabilities) {
      if (cap.schemas) schemas.push(...cap.schemas);
      if (cap.actions) actions.push(...cap.actions);
      if (cap.views) views.push(...cap.views);
      if (cap.states) states.push(...cap.states);
      if (cap.extensions?.middlewares) {
        for (const [i, mw] of cap.extensions.middlewares.entries()) {
          middlewares.push({
            name: (mw as MiddlewareRegistration).name ?? `${cap.name}_${mw.slot}_${String(i)}`,
            slot: mw.slot,
            handler: mw.handler,
            order: mw.priority ?? (mw as MiddlewareRegistration).order,
          });
        }
      }
      if (cap.extensions?.transports) transports.push(...cap.extensions.transports);
    }

    console.log(
      `[linch] Loaded ${capabilities.length} capabilities, ${schemas.length} schemas, ${actions.length} actions`,
    );
    console.log(
      `[linch] Found ${transports.length} transport(s): ${transports.map((t) => t.name).join(", ") || "none"}`,
    );

    // Build registries
    const schemaRegistry = new SchemaRegistry();
    for (const schema of schemas) {
      schemaRegistry.register(schema);
    }

    const actionRegistry = new ActionRegistry();
    for (const action of actions) {
      if (!actionRegistry.has(action.name)) {
        actionRegistry.register(action);
      }
    }

    // Build minimal runtime context for transports
    const executor = createActionExecutor({ dataProvider: createNoopDataProvider() });
    for (const action of actionRegistry.getAll()) {
      executor.registry.register(action);
    }
    const commandLayer = createCommandLayer({ executor });

    const transportCtx: TransportContext = {
      commandLayer,
      executor,
      schemaRegistry,
      schemas,
      actions,
      views,
      states,
      middlewares,
      config: config as Record<string, unknown>,
    };

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

    console.log("");
    console.log("[linch] Dev server ready. Press Ctrl+C to stop.");

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n[linch] Shutting down...");
      for (const lc of lifecycles) {
        try {
          await lc.stop();
        } catch {
          // Ignore shutdown errors
        }
      }
      process.exit(0);
    });
  },
});
