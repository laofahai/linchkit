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
  LinchKitConfig,
  LinkDefinition,
  MiddlewareRegistration,
  RuleDefinition,
  SchemaDefinition,
  StateDefinition,
  TransportAdapterDefinition,
  TransportContext,
  TransportLifecycle,
  ViewDefinition,
} from "@linchkit/core";
import { ConfigRegistry, createDerivedPropertyEngine, databaseConfig } from "@linchkit/core";
import {
  ActionRegistry,
  buildTableColumns,
  CacheManager,
  checkConnection,
  checkRestateHealth,
  closeDatabase,
  compileFlow,
  convertSchemaRelationshipFieldsToImplicitLinks,
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createAutomationEngine,
  createAutomationRegistry,
  createCommandLayer,
  createDatabase,
  createDatabaseCheck,
  createEventBus,
  createFlowRegistry,
  createFlowStepContext,
  createLinkRegistry,
  createOntologyRegistry,
  createOutboxWorker,
  createPersistentEventBus,
  createRestateFlowEngine,
  createSchemaCheck,
  createSyncFlowEngine,
  createTenantIsolationMiddleware,
  createTriggerBinding,
  DrizzleApprovalStore,
  DrizzleDataProvider,
  DrizzleExecutionLogger,
  DrizzleTransactionManager,
  detectEnvironment,
  type FlowEngine,
  GracefulShutdownManager,
  generateDrizzleSchemaFile,
  generateDrizzleTable,
  generateLinkColumns,
  HealthCheckRegistry,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  livenessCheck,
  type OutboxWorker,
  PermissionRegistry,
  runMigrations,
  SchemaRegistry,
  setupRestateEndpoint,
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
    const schemaRegistry = new SchemaRegistry();
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

    // Register all collected middlewares on the command layer
    for (const mw of middlewares) {
      commandLayer.use(mw);
    }
    if (middlewares.length > 0) {
      console.log(
        `[linch] Registered ${middlewares.length} middleware(s) on CommandLayer: ${middlewares.map((m) => `${m.name}[${m.slot}]`).join(", ")}`,
      );
    }

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

    // Create FlowRegistry and collect flows from capabilities
    const flowRegistry = createFlowRegistry();
    let flowCount = 0;
    for (const cap of capabilities) {
      if (cap.flows) {
        for (const flow of cap.flows) {
          flowRegistry.register(flow);
          flowCount++;
        }
      }
    }
    if (flowCount > 0) {
      console.log(`[linch] Registered ${flowCount} flow(s)`);
    }

    // Wire flow engine — dual-mode: Restate (durable) or Sync (fallback)
    let restateEndpoint: Awaited<ReturnType<typeof setupRestateEndpoint>> | undefined;

    if (flowCount > 0) {
      // Create step context for flow execution
      // TODO: Wire real AIService when AI integration is added in M1b
      const flowStepContext = createFlowStepContext({
        aiService: {
          complete: async () => {
            throw new Error("AI service not configured for flow execution");
          },
        },
        actionEngine: {
          execute: (actionName, input, options) => {
            // Default to system actor when no actor provided in flow context
            const actor = options?.actor ?? {
              type: "system" as const,
              id: "flow-engine",
              groups: [],
            };
            return executor.execute(actionName, input, actor, {
              tenantId: options?.tenantId,
              channel: "internal",
            });
          },
        },
        actionRegistry: actionRegistry,
      });

      // Determine which flow engine to use
      let flowEngine: FlowEngine;
      const restateConfig = config.flow?.restate;

      if (restateConfig) {
        // Attempt Restate durable execution mode
        const healthy = await checkRestateHealth(restateConfig.adminUrl);

        if (healthy) {
          console.log("[linch] Restate server detected — using durable flow execution");

          // Compile all flows into Restate workflow services
          const compiledServices: unknown[] = [];
          for (const flow of flowRegistry.getAll()) {
            const compiled = compileFlow(flow, flowStepContext);
            compiledServices.push(compiled.restateService);
          }

          // Start the Restate HTTP endpoint and register deployments
          try {
            restateEndpoint = await setupRestateEndpoint(restateConfig, compiledServices);
            const port = restateConfig.servicePort ?? 9080;
            console.log(`[linch] Restate service endpoint listening on :${port}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[linch] Failed to start Restate endpoint: ${msg}`);
            console.warn("[linch] Falling back to sync flow engine");
          }

          // Create RestateFlowEngine for starting/signaling flows via ingress
          if (restateEndpoint) {
            flowEngine = createRestateFlowEngine(restateConfig);
            for (const flow of flowRegistry.getAll()) {
              flowEngine.registerFlow(flow);
            }
          } else {
            // Restate endpoint failed — fall back to sync engine
            flowEngine = createSyncFlowEngine(flowStepContext);
            for (const flow of flowRegistry.getAll()) {
              flowEngine.registerFlow(flow);
            }
          }
        } else {
          console.log(
            "[linch] Restate server not reachable — using sync flow engine (no durability)",
          );
          flowEngine = createSyncFlowEngine(flowStepContext);
          for (const flow of flowRegistry.getAll()) {
            flowEngine.registerFlow(flow);
          }
        }
      } else {
        // No Restate config — use sync fallback
        console.log("[linch] No Restate config — using sync flow engine");
        flowEngine = createSyncFlowEngine(flowStepContext);
        for (const flow of flowRegistry.getAll()) {
          flowEngine.registerFlow(flow);
        }
      }

      // Bind flow triggers to the event bus
      // This automatically starts flows when their trigger events occur
      const triggerBinding = createTriggerBinding(eventBus);
      triggerBinding.bindAll(flowRegistry.getAll(), flowEngine);
    }

    // Build DerivedPropertyEngine — auto-computes derived fields on write and read
    const derivedPropertyEngine = createDerivedPropertyEngine();
    derivedPropertyEngine.register(schemas);
    const derivedFieldCount = schemas.reduce(
      (acc, s) => acc + derivedPropertyEngine.getDerivedFields(s.name).length,
      0,
    );
    if (derivedFieldCount > 0) {
      console.log(`[linch] DerivedPropertyEngine registered ${derivedFieldCount} derived field(s)`);
    }

    // ── Automation engine — reactive event-driven automations ──
    const automationRegistry = createAutomationRegistry();
    for (const automation of automations) {
      automationRegistry.register(automation);
    }

    const automationEngine = createAutomationEngine({
      registry: automationRegistry,
      eventBus,
      actionExecutor: {
        executeAction: async (actionName, input) => {
          const result = await executor.execute(
            actionName,
            input,
            { type: "system", id: "automation-engine", groups: [] },
            { channel: "internal" },
          );
          return result;
        },
      },
    });

    if (automations.length > 0) {
      automationEngine.start();
      console.log(`[linch] AutomationEngine started with ${automations.length} automation(s)`);
    }

    // Build OntologyRegistry — unified semantic facade over all registries
    const ontologyRegistry = createOntologyRegistry({
      schemas: schemaRegistry,
      actions: actionRegistry,
      rules,
      states,
      views,
      links: linkRegistry,
      flows: flowRegistry,
      handlers: eventHandlerRegistry,
    });
    console.log(
      `[linch] OntologyRegistry built (${ontologyRegistry.listSchemas().length} schemas)`,
    );

    // ── Health check registry ──
    const healthCheckRegistry = new HealthCheckRegistry();
    healthCheckRegistry.register("liveness", livenessCheck);
    if (dbInstance) {
      healthCheckRegistry.register(
        "database",
        createDatabaseCheck(async () => {
          // biome-ignore lint/style/noNonNullAssertion: guarded by if(dbInstance)
          await checkConnection(dbInstance!);
          return true;
        }),
      );
    }
    healthCheckRegistry.register(
      "schemas",
      createSchemaCheck(() => schemaRegistry.getAll().length),
    );
    console.log(
      `[linch] HealthCheckRegistry: ${healthCheckRegistry.list().length} check(s) registered (${healthCheckRegistry.list().join(", ")})`,
    );

    // ── Cache manager with event-driven invalidation ──
    const cacheManager = new CacheManager({
      eventBus,
      defaultTtl: environment.isDevelopment ? 30_000 : 300_000, // 30s dev, 5min prod
    });
    console.log("[linch] CacheManager created (event-driven invalidation enabled)");

    const transportCtx: TransportContext = {
      commandLayer,
      executor,
      schemaRegistry,
      schemas,
      actions,
      views,
      states,
      links,
      linkRegistry,
      middlewares,
      config: registry,
      dataProvider: devDataProvider,
      eventBus,
      executionLogger,
      approvalEngine,
      permissionRegistry,
      flowRegistry,
      capabilities,
      ontologyRegistry,
      cacheManager,
      healthCheckRegistry,
      environment,
      derivedPropertyEngine,
      automationEngine,
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

    // ── Graceful shutdown manager ──
    const shutdownManager = new GracefulShutdownManager({ timeoutMs: 15_000 });

    // Priority 10: drain transports (HTTP connections, etc.)
    for (const lc of lifecycles) {
      shutdownManager.register("transport", () => lc.stop(), 10);
    }

    // Priority 15: stop automation engine
    if (automations.length > 0) {
      shutdownManager.register("automation-engine", () => automationEngine.stop(), 15);
    }

    // Priority 20: stop event bus + outbox worker
    if (eventBus) {
      shutdownManager.register(
        "event-bus",
        () => {
          // EventBus doesn't have an explicit stop — no-op placeholder for future use
        },
        20,
      );
    }
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
