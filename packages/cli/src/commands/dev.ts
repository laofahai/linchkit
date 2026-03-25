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
  AutomationDefinition,
  CapabilityDefinition,
  DataProvider,
  EventHandlerDefinition,
  InterfaceDefinition,
  LinchKitConfig,
  LinkDefinition,
  MiddlewareRegistration,
  RuleDefinition,
  SchemaDefinition,
  StateDefinition,
  TransportAdapterDefinition,
  TransportLifecycle,
  ViewDefinition,
} from "@linchkit/core";
import { ConfigRegistry, databaseConfig } from "@linchkit/core";
import {
  ActionRegistry,
  buildTableColumns,
  closeDatabase,
  convertSchemaRelationshipFieldsToImplicitLinks,
  createDatabase,
  createInterfaceRegistry,
  createLinkRegistry,
  createTenantIsolationMiddleware,
  DrizzleDataProvider,
  InMemoryStore,
  detectEnvironment,
  GracefulShutdownManager,
  generateDrizzleSchemaFile,
  generateDrizzleTable,
  generateLinkColumns,
  PermissionRegistry,
  runMigrations,
  SchemaRegistry,
  TableRegistry,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import { getTableConfig, pgTable } from "drizzle-orm/pg-core";
import { generateCapabilityStylesheet } from "../utils/generate-capability-styles";
import { loadConfig } from "../utils/load-config";
import { wireDevEngines } from "./dev-wiring";

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

    const interfaces: InterfaceDefinition[] = [];
    const schemas: SchemaDefinition[] = [];
    const actions: ActionDefinition[] = [];
    const views: ViewDefinition[] = [];
    const states: StateDefinition[] = [];
    const links: LinkDefinition[] = [];
    const rules: RuleDefinition[] = [];
    const eventHandlers: EventHandlerDefinition[] = [];
    const automations: AutomationDefinition[] = [];
    const middlewares: MiddlewareRegistration[] = [];
    const transports: TransportAdapterDefinition[] = [];

    for (const cap of capabilities) {
      if (cap.interfaces) interfaces.push(...cap.interfaces);
      if (cap.schemas) schemas.push(...cap.schemas);
      if (cap.actions) actions.push(...cap.actions);
      if (cap.views) views.push(...cap.views);
      if (cap.states) states.push(...cap.states);
      if (cap.links) links.push(...cap.links);
      if (cap.rules) rules.push(...cap.rules);
      if (cap.eventHandlers) eventHandlers.push(...cap.eventHandlers);
      if (cap.automations) automations.push(...cap.automations);
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

    // Auto-promote schema relationship fields to implicit links
    // This converts ref/has_many/many_to_many fields into LinkDefinitions
    // and merges them with explicit defineLink declarations
    const { implicitLinks, conflicts, missingTargets } =
      convertSchemaRelationshipFieldsToImplicitLinks(schemas, links);
    if (conflicts.length > 0) {
      console.warn(
        `[linch] Found ${conflicts.length} conflict(s) between implicit and explicit links:`,
      );
      for (const c of conflicts) {
        console.warn(
          `[linch]   - "${c.name}": explicit declaration overrides implicit from schema field`,
        );
      }
    }
    if (missingTargets.length > 0) {
      console.warn(
        `[linch] Found ${missingTargets.length} relationship field(s) with missing target schemas:`,
      );
      for (const mt of missingTargets) {
        console.warn(
          `[linch]   - ${mt.schemaName}.${mt.fieldName}: target schema "${mt.target}" not found - skipped`,
        );
      }
    }
    if (implicitLinks.length > 0) {
      links.push(...implicitLinks);
      console.log(
        `[linch] Auto-promoted ${implicitLinks.length} relationship field(s) to implicit links`,
      );
    }

    // Build registries
    // Create InterfaceRegistry and register all interfaces BEFORE schemas,
    // so that interface field injection and validation happen during schema registration.
    const interfaceRegistry = createInterfaceRegistry();
    for (const iface of interfaces) {
      interfaceRegistry.register(iface);
    }
    if (interfaces.length > 0) {
      console.log(`[linch] Registered ${interfaces.length} interface(s): ${interfaces.map((i) => i.name).join(", ")}`);
    }

    const schemaRegistry = new SchemaRegistry();
    schemaRegistry.setInterfaceRegistry(interfaceRegistry);
    for (const schema of schemas) {
      schemaRegistry.register(schema);
    }

    // Register all links (explicit + implicit) in LinkRegistry
    const linkRegistry = createLinkRegistry();
    for (const link of links) {
      linkRegistry.register(link);
    }
    if (links.length > 0) {
      console.log(
        `[linch] Registered ${links.length} total link(s) (${links.length - implicitLinks.length} explicit, ${implicitLinks.length} implicit)`,
      );
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

    // ── Tenant isolation middleware — always registered ──
    // In dev mode, tenant is optional (requireTenant: false).
    // In production, tenant is required for non-system actors.
    const tenantMiddleware = createTenantIsolationMiddleware({
      requireTenant: !environment.isDevelopment,
    });
    middlewares.push(tenantMiddleware);
    // Tenant-aware DataProvider wrapping is handled inside ActionExecutor:
    // when tenantId is present in ExecuteOptions (set by CommandLayer from ctx.tenantId),
    // the executor wraps the DataProvider with createTenantAwareDataProvider for
    // full row-level isolation on all CRUD operations.
    console.log(
      `[linch] Tenant isolation middleware registered (requireTenant=${!environment.isDevelopment})`,
    );

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
          const migrationMsg =
            migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
          if (
            migrationMsg.includes("No migrations found") ||
            migrationMsg.includes("no such file")
          ) {
            console.log(
              "[linch] No migrations found — run 'bun run db:generate' to create initial migration",
            );
          } else {
            throw migrationErr;
          }
        }

        // Build runtime TableRegistry for DrizzleDataProvider query routing.
        // Phase 1: Generate base tables from schema fields to get table references for .references()
        // Phase 2: Collect all extra FK columns needed for each table
        // Phase 3: Re-generate complete tables with all FK columns included
        // Phase 4: Register junction tables (many_to_many)
        const tableRegistry = new TableRegistry();

        const baseTableMap: Record<string, ReturnType<typeof pgTable>> = {};
        const extraFkColumns: Record<string, Record<string, unknown>> = {};

        for (const schema of schemas) {
          baseTableMap[schema.name] = generateDrizzleTable(schema);
        }

        // Collect FK columns that need to be added to existing tables from links
        if (links.length > 0) {
          const { fkColumns, junctionTables } = generateLinkColumns(links, baseTableMap);

          // Merge collected FK columns into extraFkColumns map
          for (const [tableName, cols] of Object.entries(fkColumns)) {
            if (!extraFkColumns[tableName]) {
              extraFkColumns[tableName] = {};
            }
            Object.assign(extraFkColumns[tableName], cols);
          }

          // Register junction tables (many_to_many links)
          for (const jt of junctionTables) {
            const jtName = getTableConfig(jt).name;
            tableRegistry.register(jtName, jt);
          }
        }

        // Re-generate complete tables with all extra FK columns included.
        // buildTableColumns() creates fresh Drizzle column builder instances
        // (built columns can't have .setName() called again by pgTable).
        const finalTableMap: Record<string, ReturnType<typeof pgTable>> = {};

        for (const schema of schemas) {
          const tableName = schema.name;
          const columns = buildTableColumns(schema);

          // Merge extra FK columns from links
          const extraCols = extraFkColumns[tableName];
          if (extraCols) Object.assign(columns, extraCols);

          finalTableMap[tableName] = pgTable(tableName, columns);
        }

        for (const [name, table] of Object.entries(finalTableMap)) {
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
    const devDataProvider: DataProvider = dataProvider ?? new InMemoryStore();

    // Generic auth provider discovery from registered capabilities.
    // Auth provider capabilities register via extensions.authProvider.
    // This replaces hardcoded provider imports — the framework stays generic.
    const authProviderExt = capabilities
      .flatMap((cap) => (cap.extensions?.authProvider ? [cap.extensions.authProvider] : []))
      .at(0); // only one active provider

    if (authProviderExt && usingDatabase && dbInstance) {
      try {
        const { createCapAuth, capAuthConfig } = await import("@linchkit/cap-auth");
        const provider = authProviderExt.create({
          database: dbInstance,
          dataProvider: devDataProvider,
        });
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

    // ── Wire all runtime engines (executor, event bus, flows, automation, etc.) ──
    const {
      transportCtx,
      restateEndpoint,
      outboxWorker,
      automationEngine,
      automationsStarted,
    } = await wireDevEngines({
      config,
      registry,
      environment,
      schemaRegistry,
      actionRegistry,
      linkRegistry,
      interfaceRegistry,
      permissionRegistry,
      schemas,
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
