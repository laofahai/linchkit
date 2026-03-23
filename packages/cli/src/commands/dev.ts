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
  ConfigRegistry,
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createCommandLayer,
  createEventBus,
  databaseConfig,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  SchemaRegistry,
} from "@linchkit/core";
import {
  closeDatabase,
  createDatabase,
  createOutboxWorker,
  createPersistentEventBus,
  DrizzleApprovalStore,
  DrizzleDataProvider,
  DrizzleExecutionLogger,
  DrizzleTransactionManager,
  generateDrizzleSchemaFile,
  generateDrizzleTable,
  type OutboxWorker,
  TableRegistry,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import { generateCapabilityStylesheet } from "../utils/generate-capability-styles";
import { loadConfig } from "../utils/load-config";

/** Simple in-memory DataProvider for dev fallback when no database is configured. */
function createDevFallbackProvider(): DataProvider {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const table = (schema: string) => {
    if (!tables.has(schema)) tables.set(schema, new Map());
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by has() check above
    return tables.get(schema)!;
  };
  return {
    async get(schema, id) {
      const r = table(schema).get(id);
      if (!r) throw new Error(`Record not found: ${schema}/${id}`);
      return { ...r };
    },
    async query(schema, filter) {
      let records = Array.from(table(schema).values()).map((r) => ({ ...r }));
      // Simple equality filtering (skip meta keys)
      const metaKeys = new Set(["page", "pageSize", "sortField", "sortOrder", "offset", "limit"]);
      for (const [k, v] of Object.entries(filter)) {
        if (metaKeys.has(k) || v === undefined || v === null) continue;
        records = records.filter((r) => r[k] === v);
      }
      const offset = (filter.offset as number | undefined) ?? 0;
      const limit = (filter.limit as number | undefined) ?? records.length;
      return records.slice(offset, offset + limit);
    },
    async create(schema, data) {
      const now = new Date().toISOString();
      const id = (data.id as string) || crypto.randomUUID();
      const record = { ...data, id, created_at: now, updated_at: now, _version: 1 };
      table(schema).set(id, record);
      return { ...record };
    },
    async update(schema, id, data) {
      const existing = table(schema).get(id);
      if (!existing) throw new Error(`Record not found: ${schema}/${id}`);
      const updated = { ...existing, ...data, id, updated_at: new Date().toISOString() };
      table(schema).set(id, updated);
      return { ...updated };
    },
    async delete(schema, id) {
      if (!table(schema).has(id)) throw new Error(`Record not found: ${schema}/${id}`);
      table(schema).delete(id);
    },
    async count(schema, filter) {
      if (!filter) return table(schema).size;
      let records = Array.from(table(schema).values());
      for (const [k, v] of Object.entries(filter)) {
        if (v === undefined || v === null) continue;
        records = records.filter((r) => r[k] === v);
      }
      return records.length;
    },
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

    // ── Database setup — read config from registry ──
    let dataProvider: DataProvider | undefined;
    let usingDatabase = false;
    let dbInstance: ReturnType<typeof createDatabase> | undefined;

    // Read database config from ConfigRegistry (env vars already resolved, validated)
    const dbConf = databaseConfig.from({ config: registry });

    if (dbConf.url) {
      try {
        console.log("[linch] Connecting to PostgreSQL...");
        dbInstance = createDatabase({
          url: dbConf.url,
          poolSize: dbConf.poolSize,
          debug: dbConf.debug,
        });

        // Generate schema barrel file and push to database via drizzle-kit
        const schemaFile = generateDrizzleSchemaFile(schemas);
        console.log(`[linch] Generated Drizzle schema: ${schemaFile}`);

        console.log("[linch] Pushing schema to database via drizzle-kit...");
        const pushResult = Bun.spawnSync(
          ["bun", "./node_modules/.bin/drizzle-kit", "push", "--force"],
          {
            cwd: process.cwd(),
            env: { ...process.env, DATABASE_URL: dbConf.url },
            stdout: "inherit",
            stderr: "inherit",
          },
        );
        if (pushResult.exitCode !== 0) {
          console.warn("[linch] drizzle-kit push failed — falling back to in-memory store");
          await closeDatabase();
          dbInstance = undefined;
          throw new Error("drizzle-kit push failed");
        }

        // Build runtime TableRegistry for DrizzleDataProvider query routing
        const tableRegistry = new TableRegistry();
        for (const schema of schemas) {
          const table = generateDrizzleTable(schema);
          tableRegistry.register(schema.name, table);
        }

        dataProvider = new DrizzleDataProvider(dbInstance, tableRegistry);
        usingDatabase = true;
        console.log("[linch] Using PostgreSQL data provider");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[linch] Failed to connect to PostgreSQL: ${msg}`);
        // Clean up the database connection pool before falling back
        await closeDatabase();
        dbInstance = undefined;
        console.log("[linch] Falling back to InMemoryStore");
      }
    } else {
      console.log("[linch] Using InMemoryStore (no DATABASE_URL configured)");
    }

    // Build minimal runtime context for transports.
    const devDataProvider: DataProvider = dataProvider ?? createDevFallbackProvider();

    // Generic auth provider discovery from registered capabilities.
    // Auth provider capabilities register via extensions.authProvider.
    // This replaces hardcoded provider imports — the framework stays generic.
    const authProviderExt = capabilities
      .flatMap((cap) => (cap.extensions?.authProvider ? [cap.extensions.authProvider] : []))
      .at(0); // only one active provider

    if (authProviderExt && usingDatabase && dbInstance) {
      try {
        const { createCapAuth, capAuthConfig } = await import("@linchkit/cap-auth");
        const provider = authProviderExt.create({ database: dbInstance });
        // Forward config from ConfigRegistry so middleware gets sessionCookieName etc.
        const authCfg = registry.has("cap-auth")
          ? capAuthConfig.from({ config: registry })
          : undefined;
        const rewiredCap = createCapAuth({ provider, config: authCfg });

        // Replace auth actions and middlewares in registries
        if (rewiredCap.actions) {
          for (const action of rewiredCap.actions) {
            const isNew = !actionRegistry.has(action.name);
            actionRegistry.register(action, { overwrite: true });
            if (isNew) {
              actions.push(action);
            }
          }
        }
        if (rewiredCap.extensions?.middlewares) {
          for (const [i, mw] of rewiredCap.extensions.middlewares.entries()) {
            const name = `cap-auth_${mw.slot}_${String(i)}`;
            const existingIdx = middlewares.findIndex((m) => m.name?.startsWith("cap-auth"));
            if (existingIdx >= 0) {
              middlewares[existingIdx] = {
                name,
                slot: mw.slot,
                handler: mw.handler,
                order: mw.priority ?? 50,
              };
            } else {
              middlewares.push({
                name,
                slot: mw.slot,
                handler: mw.handler,
                order: mw.priority ?? 50,
              });
            }
          }
        }
        console.log(`[linch] Auth provider "${authProviderExt.name}" wired into cap-auth`);

        // Seed admin user if the provider supports it
        if (authProviderExt.seedAdmin) {
          await authProviderExt.seedAdmin({ database: dbInstance });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[linch] Failed to wire auth provider "${authProviderExt.name}": ${msg}`);
      }
    } else if (authProviderExt && !dbInstance) {
      console.log(
        `[linch] Auth provider "${authProviderExt.name}" registered but no database — skipping wiring`,
      );
    }

    // Create execution logger — Drizzle-backed when DB is available
    const executionLogger = dbInstance
      ? new DrizzleExecutionLogger(dbInstance)
      : new InMemoryExecutionLogger();
    console.log(
      `[linch] Using ${dbInstance ? "DrizzleExecutionLogger" : "InMemoryExecutionLogger"}`,
    );

    // Create approval store — Drizzle-backed when DB is available
    const approvalStore = dbInstance
      ? new DrizzleApprovalStore(dbInstance)
      : new InMemoryApprovalStore();
    console.log(`[linch] Using ${dbInstance ? "DrizzleApprovalStore" : "InMemoryApprovalStore"}`);

    // Create transaction manager when DB is available (Transactional Outbox pattern)
    const transactionManager =
      dbInstance && dataProvider instanceof DrizzleDataProvider
        ? new DrizzleTransactionManager(dbInstance, dataProvider)
        : undefined;
    if (transactionManager) {
      console.log("[linch] Using DrizzleTransactionManager (Transactional Outbox)");
    }

    const executor = createActionExecutor({
      dataProvider: devDataProvider,
      transactionManager,
      executionLogger,
      configRegistry: registry,
    });
    for (const action of actionRegistry.getAll()) {
      executor.registry.register(action);
    }
    const commandLayer = createCommandLayer({
      executor,
      verifyApproval: createApprovalVerifier(approvalStore),
    });

    // Create event bus — use PersistentEventBus when database is available
    const { bus: eventBus, registry: eventHandlerRegistry } = dbInstance
      ? createPersistentEventBus(dbInstance)
      : createEventBus();

    // Start OutboxWorker for reliable event retry when DB is available
    let outboxWorker: OutboxWorker | undefined;
    if (dbInstance && eventHandlerRegistry) {
      outboxWorker = createOutboxWorker({
        db: dbInstance,
        registry: eventHandlerRegistry,
      });
      outboxWorker.start();
      console.log("[linch] Using PersistentEventBus + OutboxWorker (events persisted to database)");
    } else {
      console.log("[linch] Using in-memory EventBus");
    }

    // Create approval engine — wired with event bus and command layer for re-execution
    const approvalEngine = createApprovalEngine({
      store: approvalStore,
      eventBus,
      commandLayer,
      enforceAssignee: false, // M0b: not enforced yet
    });

    const transportCtx: TransportContext = {
      commandLayer,
      executor,
      schemaRegistry,
      schemas,
      actions,
      views,
      states,
      middlewares,
      config: registry,
      dataProvider: devDataProvider,
      eventBus,
      executionLogger,
      approvalEngine,
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
      if (outboxWorker) {
        await outboxWorker.stop();
      }
      if (usingDatabase) {
        await closeDatabase();
        console.log("[linch] Database connection closed.");
      }
      process.exit(0);
    });
  },
});
