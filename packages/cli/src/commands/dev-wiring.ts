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
  DetectingSensor,
  EntityDefinition,
  LinchKitConfig,
  MiddlewareRegistration,
  RelationDefinition,
  RuleDefinition,
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
  DrizzleApprovalStore,
  DrizzleDataProvider,
  DrizzleExecutionLogger,
  DrizzleTransactionManager,
  type EntityRegistry,
  type FlowEngine,
  HealthCheckRegistry,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  livenessCheck,
  type OutboxWorker,
  type PermissionRegistry,
} from "@linchkit/core/server";

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
  capabilities: CapabilityDefinition[];

  /** Sensors collected from cap.extensions.sensors (Spec 55 §3.3) */
  sensors: DetectingSensor[];

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
    capabilities,
    sensors,
    dbInstance,
    dataProvider,
  } = input;

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

  // Create transaction manager when DB is available (Transactional Outbox pattern)
  const transactionManager =
    dbInstance && input.dataProvider instanceof DrizzleDataProvider
      ? new DrizzleTransactionManager(dbInstance, input.dataProvider as DrizzleDataProvider)
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

  const executor = createActionExecutor({
    dataProvider,
    transactionManager,
    executionLogger,
    configRegistry: registry,
    eventBus,
    capabilityNames,
    entityRegistry,
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
    query: createDispatchQuery({ dataProvider, executionLogger }),
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
    dataProvider,
    eventBus,
    executionLogger,
    approvalEngine,
    permissionRegistry,
    flowRegistry,
    flowEngine,
    capabilities,
    ontologyRegistry,
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
