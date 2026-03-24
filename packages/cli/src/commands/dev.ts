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
  LinkDefinition,
  MiddlewareRegistration,
  SchemaDefinition,
  StateDefinition,
  TransportAdapterDefinition,
  TransportContext,
  TransportLifecycle,
  ViewDefinition,
} from "@linchkit/core";
import { ConfigRegistry, databaseConfig } from "@linchkit/core";
import {
  ActionRegistry,
  closeDatabase,
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createCommandLayer,
  createDatabase,
  createEventBus,
  createOutboxWorker,
  createPersistentEventBus,
  DrizzleApprovalStore,
  DrizzleDataProvider,
  DrizzleExecutionLogger,
  DrizzleTransactionManager,
  generateDrizzleSchemaFile,
  generateDrizzleTable,
  generateLinkColumns,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  type OutboxWorker,
  PermissionRegistry,
  runMigrations,
  SchemaRegistry,
  TableRegistry,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
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
    const links: LinkDefinition[] = [];
    const middlewares: MiddlewareRegistration[] = [];
    const transports: TransportAdapterDefinition[] = [];

    for (const cap of capabilities) {
      if (cap.schemas) schemas.push(...cap.schemas);
      if (cap.actions) actions.push(...cap.actions);
      if (cap.views) views.push(...cap.views);
      if (cap.states) states.push(...cap.states);
      if (cap.links) links.push(...cap.links);
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

    // ── Permission group discovery — scan capabilities for extensions.permissionGroups ──
    const permissionRegistry = new PermissionRegistry();
    for (const cap of capabilities) {
      if (cap.extensions?.permissionGroups) {
        for (const group of cap.extensions.permissionGroups) {
          if (!permissionRegistry.get(group.name)) {
            permissionRegistry.register(group);
          }
        }
      }
    }
    const registeredGroups = permissionRegistry.getAll();
    if (registeredGroups.length > 0) {
      console.log(
        `[linch] Registered ${registeredGroups.length} permission group(s): ${registeredGroups.map((g) => g.name).join(", ")}`,
      );
    }

    // Wire permission middleware into cap-permission if it was loaded without
    // an explicit registry (i.e. no middlewares in its extensions yet).
    // This enables auto-discovery: capabilities declare permissionGroups,
    // dev.ts collects them, and wires the middleware here.
    const capPermissionDef = capabilities.find((c) => c.name === "cap-permission");
    if (capPermissionDef && registeredGroups.length > 0) {
      const hasPermissionMiddleware = capPermissionDef.extensions?.middlewares?.some(
        (mw) => mw.slot === "permission",
      );
      if (!hasPermissionMiddleware) {
        try {
          const { createPermissionMiddleware } = await import("@linchkit/cap-permission");
          const capPermCfg = registry.has("cap-permission")
            ? (registry.get("cap-permission") as Record<string, unknown>)
            : undefined;
          const permMw = {
            name: "cap-permission_permission_0",
            slot: "permission" as const,
            handler: createPermissionMiddleware({
              registry: permissionRegistry,
              publicActions: capPermCfg?.publicActions as string[] | undefined,
            }),
            order: 50,
          };
          middlewares.push(permMw);
          console.log("[linch] Auto-wired permission middleware from discovered permission groups");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[linch] Failed to auto-wire permission middleware: ${msg}`);
        }
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

        // Generate schema barrel file (still needed for drizzle-kit generate/studio)
        const schemaFile = generateDrizzleSchemaFile(schemas, undefined, undefined, links);
        console.log(`[linch] Generated Drizzle schema: ${schemaFile}`);

        // Apply any pending migrations
        console.log("[linch] Applying database migrations...");
        try {
          await runMigrations(dbInstance);
          console.log("[linch] Migrations applied successfully");
        } catch (migrationErr) {
          const migrationMsg = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
          if (migrationMsg.includes("No migrations found") || migrationMsg.includes("no such file")) {
            console.log("[linch] No migrations found — run 'bun run db:generate' to create initial migration");
          } else {
            throw migrationErr;
          }
        }

        // Build runtime TableRegistry for DrizzleDataProvider query routing.
        // Phase 1: Generate base tables from schema fields
        // Phase 2: Merge Link FK columns into affected tables
        // Phase 3: Register junction tables (many_to_many)
        const tableRegistry = new TableRegistry();

        // biome-ignore lint/suspicious/noExplicitAny: Drizzle pgTable accepts dynamic column definitions
        const baseTableMap: Record<string, ReturnType<typeof pgTable>> = {};
        for (const schema of schemas) {
          baseTableMap[schema.name] = generateDrizzleTable(schema);
        }

        // Merge Link FK columns into base tables so DrizzleDataProvider can read/write them
        if (links.length > 0) {
          const { fkColumns, junctionTables } = generateLinkColumns(links, baseTableMap);

          for (const [tableName, extraCols] of Object.entries(fkColumns)) {
            const existing = baseTableMap[tableName];
            if (!existing) continue;

            // biome-ignore lint/suspicious/noExplicitAny: Drizzle pgTable accepts dynamic column definitions
            const existingCols: Record<string, any> = {};
            for (const col of getTableConfig(existing).columns) {
              existingCols[col.name] = col;
            }

            baseTableMap[tableName] = pgTable(tableName, { ...existingCols, ...extraCols });
          }

          // Register junction tables (many_to_many links)
          for (const jt of junctionTables) {
            const jtName = getTableConfig(jt).name;
            tableRegistry.register(jtName, jt);
          }
        }

        for (const [name, table] of Object.entries(baseTableMap)) {
          tableRegistry.register(name, table);
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
        const provider = authProviderExt.create({ database: dbInstance, dataProvider: devDataProvider });
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
      links,
      middlewares,
      config: registry,
      dataProvider: devDataProvider,
      eventBus,
      executionLogger,
      approvalEngine,
      permissionRegistry,
      capabilities,
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
