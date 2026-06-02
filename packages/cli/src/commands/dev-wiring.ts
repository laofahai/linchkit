/**
 * Dev server engine wiring — creates all runtime engines, registries,
 * and returns the TransportContext needed to start transports.
 *
 * Extracted from dev.ts to keep the command orchestration file focused
 * on config loading, capability collection, and transport lifecycle.
 */

import { createAIService } from "@linchkit/cap-ai-provider";
import {
  checkRestateHealth,
  compileFlow,
  createRestateFlowEngine,
  setupRestateEndpoint,
} from "@linchkit/cap-flow-restate";
import type {
  ActionDefinition,
  CapabilityDefinition,
  DataProvider,
  EntityDefinition,
  InterceptorRegistration,
  LinchKitConfig,
  MiddlewareRegistration,
  RelationDefinition,
  RuleDefinition,
  Sensor,
  StateDefinition,
  TransportContext,
  ViewDefinition,
} from "@linchkit/core";
import {
  type ConfigRegistry,
  createDerivedPropertyEngine,
  createDispatchQuery,
  createEvolutionRuntime,
} from "@linchkit/core";
import {
  type ActionRegistry,
  AIAuditLogger,
  AIBoundary,
  CacheManager,
  checkConnection,
  consoleLogger,
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createCacheCheck,
  createCommandLayer,
  createDatabaseCheck,
  createEntityCheck,
  createEventBus,
  createEventBusCheck,
  createFlowRegistry,
  createFlowStepContext,
  createNoopAIService,
  createOntologyRegistry,
  createOutboxWorker,
  createPersistentEventBus,
  type createRelationRegistry,
  createSyncFlowEngine,
  createTriggerBinding,
  DefaultOverlayRegistry,
  DrizzleApprovalStore,
  DrizzleDataProvider,
  DrizzleExecutionLogger,
  DrizzleOverlayStore,
  DrizzleTransactionManager,
  type EntityRegistry,
  type FlowEngine,
  HealthCheckRegistry,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  InMemoryOverlayStore,
  livenessCheck,
  type OutboxWorker,
  OverlayAwareDataProvider,
  type OverlayRegistry,
  type PermissionRegistry,
} from "@linchkit/core/server";
import { buildInterceptorRegistry } from "./startup/build-interceptor-registry";

// ── Input types ─────────────────────────────────────────────

export interface WireDevEnginesInput {
  config: LinchKitConfig;
  registry: ConfigRegistry;
  environment: ReturnType<typeof import("@linchkit/core/server").detectEnvironment>;

  // Registries already built during capability collection
  entityRegistry: InstanceType<typeof EntityRegistry>;
  actionRegistry: InstanceType<typeof ActionRegistry>;
  relationRegistry: ReturnType<typeof createRelationRegistry>;
  interfaceRegistry?: ReturnType<typeof import("@linchkit/core/server").createInterfaceRegistry>;
  permissionRegistry: InstanceType<typeof PermissionRegistry>;

  // Collected definitions from capabilities
  entities: EntityDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  states: StateDefinition[];
  links: RelationDefinition[];
  rules: RuleDefinition[];
  middlewares: MiddlewareRegistration[];
  /** Interceptors collected from cap.extensions.interceptors (Spec 63 Phase 3) */
  interceptors: InterceptorRegistration[];
  capabilities: CapabilityDefinition[];

  /** Sensors collected from cap.extensions.sensors (Spec 55 §3.3) */
  sensors: Sensor[];

  // Database state (may be undefined if no DB)
  dbInstance?: ReturnType<typeof import("@linchkit/core/server").createDatabase>;
  dataProvider: DataProvider;
  usingDatabase: boolean;
}

export interface WireDevEnginesResult {
  transportCtx: TransportContext;
  /** Restate endpoint handle for shutdown (if started) */
  restateEndpoint?: Awaited<ReturnType<typeof setupRestateEndpoint>>;
  /** OutboxWorker handle for shutdown (if started) */
  outboxWorker?: OutboxWorker;
}

// ── Main wiring function ────────────────────────────────────

export async function wireDevEngines(input: WireDevEnginesInput): Promise<WireDevEnginesResult> {
  const {
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
    interceptors,
    capabilities,
    sensors,
    dbInstance,
    dataProvider,
  } = input;

  // ── Overlay registry — Spec 59 §8.1 ──────────────────────────────────
  // Constructed exactly once per dev session and assigned to
  // transportCtx.overlayRegistry so cap-adapter-mcp, the REST overlay
  // routes, and the GraphQL overlay-aware schema builder all read from the
  // same instance. An overlay registered via the API is therefore visible
  // through MCP introspection without a server restart.
  //
  // The runtime DataProvider is wrapped with `OverlayAwareDataProvider`
  // below (after the registry initializes) so action writes that include
  // overlay-managed fields fold their values into the `_extensions` JSONB
  // column instead of hitting non-existent code-defined columns. The
  // wrapper survives the transactional path: `OverlayAwareDataProvider`
  // implements `withConnection`, and `DrizzleTransactionManager` accepts
  // a `wrapForTx` callback so the same wrapper class re-wraps the
  // tx-scoped Drizzle provider before the handler runs (issue #156).
  const overlayStore = dbInstance
    ? new DrizzleOverlayStore(dbInstance)
    : new InMemoryOverlayStore();
  const overlayRegistry: OverlayRegistry = new DefaultOverlayRegistry(overlayStore);
  // Initialize loads existing overlays into the in-memory cache. We deliberately
  // let any DB-side error propagate (the rest of the dev session relies on
  // overlays being present) but wrap in try/catch to attach a contextual
  // diagnostic — the most common cause is "migrations not yet run".
  try {
    await overlayRegistry.initialize();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OverlayRegistry initialization failed: ${cause}. ` +
        "If this is the first time running with this DATABASE_URL, " +
        "ensure migrations have been applied (e.g. `bun run migration:apply`).",
      { cause: err },
    );
  }
  consoleLogger.info(
    dbInstance ? "Overlay registry: drizzle" : "Overlay registry: in-memory (no DB)",
  );

  // Wrap the runtime DataProvider with `OverlayAwareDataProvider` so action
  // writes split overlay-managed fields into `_extensions` and reads spread
  // them back. The transactional path is preserved by the wrapper's own
  // `withConnection` implementation (used when no transaction manager is in
  // play) and by the `wrapForTx` callback below (used when one is).
  const overlayAwareDataProvider = new OverlayAwareDataProvider(dataProvider, overlayRegistry);

  // Create execution logger — Drizzle-backed when DB is available
  const executionLogger = dbInstance
    ? new DrizzleExecutionLogger(dbInstance)
    : new InMemoryExecutionLogger();
  consoleLogger.info(`Using ${dbInstance ? "DrizzleExecutionLogger" : "InMemoryExecutionLogger"}`);

  // Create approval store — Drizzle-backed when DB is available
  const approvalStore = dbInstance
    ? new DrizzleApprovalStore(dbInstance)
    : new InMemoryApprovalStore();
  consoleLogger.info(`Using ${dbInstance ? "DrizzleApprovalStore" : "InMemoryApprovalStore"}`);

  // Create transaction manager when DB is available (Transactional Outbox pattern).
  // The `wrapForTx` callback re-applies the OverlayAwareDataProvider wrapper to
  // the transaction-scoped DrizzleDataProvider so overlay field writes inside an
  // open tx still fold into `_extensions` (issue #156).
  const transactionManager =
    dbInstance && input.dataProvider instanceof DrizzleDataProvider
      ? new DrizzleTransactionManager(dbInstance, input.dataProvider as DrizzleDataProvider, {
          wrapForTx: (txProvider) => new OverlayAwareDataProvider(txProvider, overlayRegistry),
        })
      : undefined;
  if (transactionManager) {
    consoleLogger.info("Using DrizzleTransactionManager (Transactional Outbox)");
  }

  // Create event bus — use PersistentEventBus when database is available
  // (must be created before executor, which depends on it)
  const { bus: eventBus, registry: eventHandlerRegistry } = dbInstance
    ? createPersistentEventBus(dbInstance)
    : createEventBus();

  // Build capability name set for ctx.hasCapability() weak dependency checks
  const capabilityNames = new Set(capabilities.map((c) => c.name));

  // Interceptor registry — value-returning extension points (Spec 63 Phase 3).
  // Built in a focused helper so the Action Engine can thread the field-lock
  // violation set through policy capabilities. When no interceptors are
  // registered, the engine's lock check behaves identically to Phase 1.
  const interceptorRegistry = buildInterceptorRegistry(interceptors);

  const executor = createActionExecutor({
    dataProvider: overlayAwareDataProvider,
    transactionManager,
    executionLogger,
    configRegistry: registry,
    eventBus,
    capabilityNames,
    entityRegistry,
    interceptorRegistry,
  });
  for (const action of actionRegistry.getAll()) {
    executor.registry.register(action);
  }
  const commandLayer = createCommandLayer({
    executor,
    verifyApproval: createApprovalVerifier(approvalStore),
    transactionManager,
  });

  // Register all collected middlewares on the command layer
  for (const mw of middlewares) {
    commandLayer.use(mw);
  }
  if (middlewares.length > 0) {
    consoleLogger.info(
      `Registered ${middlewares.length} middleware(s) on CommandLayer: ${middlewares.map((m) => `${m.name}[${m.slot}]`).join(", ")}`,
    );
  }

  // Start OutboxWorker for reliable event retry when DB is available
  let outboxWorker: OutboxWorker | undefined;
  if (dbInstance && eventHandlerRegistry) {
    outboxWorker = createOutboxWorker({
      db: dbInstance,
      registry: eventHandlerRegistry,
    });
    outboxWorker.start();
    consoleLogger.info("Using PersistentEventBus + OutboxWorker (events persisted to database)");
  } else {
    consoleLogger.info("Using in-memory EventBus");
  }

  // Create approval engine — wired with event bus and command layer for re-execution
  const approvalEngine = createApprovalEngine({
    store: approvalStore,
    eventBus,
    commandLayer,
    enforceAssignee: false, // M0b: not enforced yet
  });

  // ── AI Audit Logger — always created (lightweight, no external deps) ──
  const aiAuditLogger = new AIAuditLogger({
    onAuditEntry: (entry) => {
      consoleLogger.debug(
        `AI audit: ${entry.eventType} risk=${entry.riskLevel}${entry.actionName ? ` action=${entry.actionName}` : ""}`,
      );
    },
  });
  consoleLogger.info("AIAuditLogger created");

  // ── AI Service — create from config or use noop ──
  const aiService = config.ai ? createAIService(config.ai) : createNoopAIService();
  if (config.ai) {
    consoleLogger.info(`AIService created (provider: ${config.ai.defaultProvider})`);
  }

  // ── AI Boundary — wraps AI service with default safety policy ──
  const aiBoundary = new AIBoundary({
    aiService: aiService,
    onUsageRecord: (record) => {
      // Forward usage records to audit logger as AI call events
      aiAuditLogger.logCall({
        actorId: record.actorId,
        tenantId: record.tenantId,
        agentModel: record.model,
        input: `[${record.source}] ${record.actionName ?? "unknown"}`,
        output: record.status,
        actionName: record.actionName,
        tokenUsage: {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          totalTokens: record.totalTokens,
        },
        metadata: {
          cost: record.cost,
          duration: record.duration,
          policyName: record.policyName,
          blockReason: record.blockReason,
        },
      });
    },
    onBudgetAlert: (tenantId, budget, threshold) => {
      consoleLogger.warn(
        `AI budget alert: tenant=${tenantId ?? "global"} threshold=${threshold} costToday=$${budget.costToday.toFixed(2)}`,
      );
    },
  });
  consoleLogger.info("AIBoundary created with default policy");

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
    consoleLogger.info(`Registered ${flowCount} flow(s)`);
  }

  // Wire flow engine — dual-mode: Restate (durable) or Sync (fallback)
  let restateEndpoint: Awaited<ReturnType<typeof setupRestateEndpoint>> | undefined;
  let flowEngine: FlowEngine | undefined;

  if (flowCount > 0) {
    // Create step context for flow execution
    const flowStepContext = createFlowStepContext({
      aiService: aiService,
      aiBoundary,
      actionEngine: {
        execute: (actionName, input, options) => {
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
    const restateConfig = config.flow?.restate;

    if (restateConfig) {
      const healthy = await checkRestateHealth(restateConfig.adminUrl);

      if (healthy) {
        consoleLogger.info("Restate server detected — using durable flow execution");

        const compiledServices: unknown[] = [];
        for (const flow of flowRegistry.getAll()) {
          const compiled = compileFlow(flow, flowStepContext);
          compiledServices.push(compiled.restateService);
        }

        try {
          restateEndpoint = await setupRestateEndpoint(restateConfig, compiledServices);
          const port = restateConfig.servicePort ?? 9080;
          consoleLogger.info(`Restate service endpoint listening on :${port}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          consoleLogger.warn(`Failed to start Restate endpoint: ${msg}`);
          consoleLogger.warn("Falling back to sync flow engine");
        }

        if (restateEndpoint) {
          flowEngine = createRestateFlowEngine(restateConfig);
          for (const flow of flowRegistry.getAll()) {
            flowEngine.registerFlow(flow);
          }
        } else {
          flowEngine = createSyncFlowEngine(flowStepContext);
          for (const flow of flowRegistry.getAll()) {
            flowEngine.registerFlow(flow);
          }
        }
      } else {
        consoleLogger.info("Restate server not reachable — using sync flow engine (no durability)");
        flowEngine = createSyncFlowEngine(flowStepContext);
        for (const flow of flowRegistry.getAll()) {
          flowEngine.registerFlow(flow);
        }
      }
    } else {
      consoleLogger.info("No Restate config — using sync flow engine");
      flowEngine = createSyncFlowEngine(flowStepContext);
      for (const flow of flowRegistry.getAll()) {
        flowEngine.registerFlow(flow);
      }
    }

    // Bind flow triggers to the event bus
    const triggerBinding = createTriggerBinding(eventBus);
    triggerBinding.bindAll(flowRegistry.getAll(), flowEngine);
  }

  // Build DerivedPropertyEngine — auto-computes derived fields on write and read
  const derivedPropertyEngine = createDerivedPropertyEngine();
  derivedPropertyEngine.register(entities);
  const derivedFieldCount = entities.reduce(
    (acc, s) => acc + derivedPropertyEngine.getDerivedFields(s.name).length,
    0,
  );
  if (derivedFieldCount > 0) {
    consoleLogger.info(`DerivedPropertyEngine registered ${derivedFieldCount} derived field(s)`);
  }

  // Build OntologyRegistry — unified semantic facade over all registries
  const ontologyRegistry = createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules,
    states,
    views,
    links: relationRegistry,
    flows: flowRegistry,
    handlers: eventHandlerRegistry,
    interfaces: interfaceRegistry,
  });
  consoleLogger.info(`OntologyRegistry built (${ontologyRegistry.listEntities().length} schemas)`);

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
    createEntityCheck(() => entityRegistry.getAll().length),
  );
  healthCheckRegistry.register(
    "eventbus",
    createEventBusCheck(() => eventHandlerRegistry?.getAll().length ?? 0),
  );

  // ── Cache manager with event-driven invalidation ──
  const cacheManager = new CacheManager({
    eventBus,
    defaultTtl: environment.isDevelopment ? 30_000 : 300_000, // 30s dev, 5min prod
  });
  consoleLogger.info("CacheManager created (event-driven invalidation enabled)");

  healthCheckRegistry.register(
    "cache",
    createCacheCheck(() => {
      const s = cacheManager.stats();
      return { hits: s.l1.hits, misses: s.l1.misses, size: s.l1.size };
    }),
  );
  consoleLogger.info(
    `HealthCheckRegistry: ${healthCheckRegistry.list().length} check(s) registered (${healthCheckRegistry.list().join(", ")})`,
  );

  // ── Evolution runtime (Spec 55) — register capability sensors on SignalBus ──
  // Dispatch query routes `execution_log` → ExecutionLogger and other schemas
  // → DataProvider. Without this split, sensors reading execution_log would
  // silently see zero rows in both PostgreSQL and in-memory dev modes.
  const evolutionRuntime = createEvolutionRuntime({
    sensors,
    query: createDispatchQuery({ dataProvider: overlayAwareDataProvider, executionLogger }),
  });
  consoleLogger.info(
    `Evolution runtime ready: ${evolutionRuntime.signalBus.listSensors().length} sensor(s) registered`,
  );

  const transportCtx: TransportContext = {
    commandLayer,
    executor,
    entityRegistry,
    entities,
    actions,
    views,
    states,
    links,
    relationRegistry,
    middlewares,
    config: registry,
    dataProvider: overlayAwareDataProvider,
    eventBus,
    executionLogger,
    approvalEngine,
    permissionRegistry,
    flowRegistry,
    flowEngine,
    capabilities,
    ontologyRegistry,
    overlayRegistry,
    cacheManager,
    healthCheckRegistry,
    environment,
    derivedPropertyEngine,
    aiBoundary,
    aiAuditLogger,
    aiService,
    aiConfig: config.ai,
    evolutionRuntime,
  };

  return {
    transportCtx,
    restateEndpoint,
    outboxWorker,
  };
}
