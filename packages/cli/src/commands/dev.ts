/**
 * linch dev — Start the LinchKit development server
 *
 * Loads linchkit.config.ts from the current directory,
 * initializes the runtime context, and starts an Elysia server
 * with GraphQL and REST endpoints.
 */

import {
  buildGraphQLSchema,
  createRuntimeContext,
  createServer,
  generateCrudActions,
} from "@linchkit/cap-adapter-server";
import type {
  ActionDefinition,
  CapabilityDefinition,
  LinchKitConfig,
  SchemaDefinition,
} from "@linchkit/core";
import { defineCommand } from "citty";
import { generateCapabilityStylesheet } from "../utils/generate-capability-styles";
import { loadConfig } from "../utils/load-config";

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Start the LinchKit development server",
  },
  args: {
    port: {
      type: "string",
      description: "Server port (default: 3000)",
      default: "3000",
    },
    host: {
      type: "string",
      description: "Server host (default: localhost)",
      default: "localhost",
    },
  },
  async run({ args }) {
    const port = Number.parseInt(args.port, 10);
    const host = args.host;

    console.log("Loading LinchKit configuration...");

    // Load project config
    let config: LinchKitConfig = {};
    try {
      const result = await loadConfig();
      config = result.config;
      console.log(`  Config loaded from ${result.configPath}`);
    } catch (_err) {
      // If no config file, start with empty config (dev mode)
      console.log("  No linchkit.config.ts found, starting with empty configuration.");
    }

    // Extract schemas and actions from config capabilities
    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];

    const generatedStylesheet = generateCapabilityStylesheet(capabilities);
    if (generatedStylesheet?.updated) {
      console.log(`  Generated capability stylesheet: ${generatedStylesheet.path}`);
    }

    const schemas: SchemaDefinition[] = [];
    const actions: ActionDefinition[] = [];

    for (const cap of capabilities) {
      if (cap.schemas) schemas.push(...cap.schemas);
      if (cap.actions) actions.push(...cap.actions);
    }

    // Generate CRUD actions for schemas that don't have custom actions
    for (const schema of schemas) {
      const crudActions = generateCrudActions(schema);
      for (const crud of crudActions) {
        // Only add if not already registered by a custom action
        if (!actions.some((a) => a.name === crud.name)) {
          actions.push(crud);
        }
      }
    }

    // Create runtime context
    const runtime = createRuntimeContext({ schemas, actions });

    // Build GraphQL schema
    const graphqlSchema = buildGraphQLSchema(schemas, {
      executor: runtime.executor,
      store: runtime.store,
    });

    // Resolve server port from: CLI arg > config > default
    const serverPort = port || (config.server as { port?: number })?.port || 3000;
    const serverHost = host || (config.server as { host?: string })?.host || "localhost";

    // Create and start server
    const server = createServer(graphqlSchema, {
      port: serverPort,
      executor: runtime.executor,
    });

    server.listen(serverPort, serverHost);

    const displayHost = serverHost === "0.0.0.0" ? "localhost" : serverHost;

    console.log("");
    console.log("LinchKit Dev Server");
    console.log("-----------------------------------");
    console.log(`  HTTP:       http://${displayHost}:${serverPort}`);
    console.log(`  GraphQL:    http://${displayHost}:${serverPort}/graphql`);
    console.log(`  Health:     http://${displayHost}:${serverPort}/health`);
    console.log(`  REST API:   http://${displayHost}:${serverPort}/api/actions/:name`);
    console.log("-----------------------------------");
    console.log(`  Schemas:    ${schemas.length}`);
    console.log(`  Actions:    ${actions.length}`);
    console.log("-----------------------------------");
    console.log("");
    console.log("Press Ctrl+C to stop.");
  },
});
