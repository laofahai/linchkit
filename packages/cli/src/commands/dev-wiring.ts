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
  AutomationDefinition,
  CapabilityDefinition,
  DataProvider,
  LinchKitConfig,
  LinkDefinition,
  MiddlewareRegistration,
  RuleDefinition,
  SchemaDefinition,
  StateDefinition,
  TransportContext,
  ViewDefinition,
} from "@linchkit/core";
import { type ConfigRegistry, createDerivedPropertyEngine } from "@linchkit/core";
import {
  type ActionRegistry,
  AIAuditLogger,
  AIBoundary,
  CacheManager,
  checkConnection,
  createActionExecutor,
  createApprovalEngine,
  createApprovalVerifier,
  createAutomationEngine,
  createAutomationRegistry,
  createCacheCheck,
  createCommandLayer,
  createDatabaseCheck,
  createEventBus,
  createEventBusCheck,
  createFlowRegistry,
  createFlowStepContext,
  type createLinkRegistry,
  createNoopAIService,
  createOntologyRegistry,
  createOutboxWorker,
  createPersistentEventBus,
  createSchemaCheck,
  createSyncFlowEngine,
  createTriggerBinding,
  DrizzleApprovalStore,
  DrizzleDataProvider,
  DrizzleExecutionLogger,
  DrizzleTransactionManager,
  type FlowEngine,
  HealthCheckRegistry,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
  livenessCheck,
  type OutboxWorker,
  type PermissionRegistry,
  type SchemaRegistry,
} from "@linchkit/core/server";

// ── Input types ─────────────────────────────────────────────

export interface WireDevEnginesInput {
  config: LinchKitConfig;
  registry: ConfigRegistry;
  environment: ReturnType<typeof import("@linchkit/core/server").detectEnvironment>;

  // Registries already built during capability collection
  schemaRegistry: InstanceType<typeof SchemaRegistry>;
  actionRegistry: InstanceType<typeof ActionRegistry>;
  linkRegistry: ReturnType<typeof createLinkRegistry>;
  interfaceRegistry?: ReturnType<typeof import("@linchkit/core/server").createInterfaceRegistry>;
  permissionRegistry: InstanceType<typeof PermissionRegistry>;

  // Collected definitions from capabilities
  schemas: SchemaDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  states: StateDefinition[];
  links: LinkDefinition[];
  rules: RuleDefinition[];
  automations: AutomationDefinition[];
  middlewares: MiddlewareRegistration[];
  capabilities: CapabilityDefinition[];

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
  /** AutomationEngine for shutdown (if automations exist) */
  automationEngine: ReturnType<typeof createAutomationEngine>;
  /** Whether automations were started */
  automationsStarted: boolean;
}

// ── Main wiring function ────────────────────────────────────

export async function wireDevEngines(input: WireDevEnginesInput): Promise<WireDevEnginesResult> {
  const {
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
    dataProvider,
  } = input;

  // Create execution logger — Drizzle-backed when DB is available
  const executionLogger = dbInstance
    ? new DrizzleExecutionLogger(dbInstance)
    : new InMemoryExecutionLogger();
  console.log(`[linch] Using ${dbInstance ? "DrizzleExecutionLogger" : "InMemoryExecutionLogger"}`);

  // Create approval store — Drizzle-backed when DB is available
  const approvalStore = dbInstance
    ? new DrizzleApprovalStore(dbInstance)
    : new InMemoryApprovalStore();
  console.log(`[linch] Using ${dbInstance ? "DrizzleApprovalStore" : "InMemoryApprovalStore"}`);

  // Create transaction manager when DB is available (Transactional Outbox pattern)
  const transactionManager =
    dbInstance && input.dataProvider instanceof DrizzleDataProvider
      ? new DrizzleTransactionManager(dbInstance, input.dataProvider as DrizzleDataProvider)
      : undefined;
  if (transactionManager) {
    console.log("[linch] Using DrizzleTransactionManager (Transactional Outbox)");
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

  // ── AI Audit Logger — always created (lightweight, no external deps) ──
  const aiAuditLogger = new AIAuditLogger({
    onAuditEntry: (entry) => {
      console.log(
        `[linch] AI audit: ${entry.eventType} risk=${entry.riskLevel}${entry.actionName ? ` action=${entry.actionName}` : ""}`,
      );
    },
  });
  console.log("[linch] AIAuditLogger created");

  // ── AI Service — create from config or use noop ──
  const aiService = config.ai ? createAIService(config.ai) : createNoopAIService();
  if (config.ai) {
    console.log(`[linch] AIService created (provider: ${config.ai.defaultProvider})`);
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
      console.warn(
        `[linch] AI budget alert: tenant=${tenantId ?? "global"} threshold=${threshold} costToday=$${budget.costToday.toFixed(2)}`,
      );
    },
  });
  console.log("[linch] AIBoundary created with default policy");

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
        console.log("[linch] Restate server detected — using durable flow execution");

        const compiledServices: unknown[] = [];
        for (const flow of flowRegistry.getAll()) {
          const compiled = compileFlow(flow, flowStepContext);
          compiledServices.push(compiled.restateService);
        }

        try {
          restateEndpoint = await setupRestateEndpoint(restateConfig, compiledServices);
          const port = restateConfig.servicePort ?? 9080;
          console.log(`[linch] Restate service endpoint listening on :${port}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[linch] Failed to start Restate endpoint: ${msg}`);
          console.warn("[linch] Falling back to sync flow engine");
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
        console.log(
          "[linch] Restate server not reachable — using sync flow engine (no durability)",
        );
        flowEngine = createSyncFlowEngine(flowStepContext);
        for (const flow of flowRegistry.getAll()) {
          flowEngine.registerFlow(flow);
        }
      }
    } else {
      console.log("[linch] No Restate config — using sync flow engine");
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

  const automationsStarted = automations.length > 0;
  if (automationsStarted) {
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
    interfaces: interfaceRegistry,
  });
  console.log(`[linch] OntologyRegistry built (${ontologyRegistry.listSchemas().length} schemas)`);

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
  healthCheckRegistry.register(
    "eventbus",
    createEventBusCheck(() => eventHandlerRegistry?.getAll().length ?? 0),
  );

  // ── Cache manager with event-driven invalidation ──
  const cacheManager = new CacheManager({
    eventBus,
    defaultTtl: environment.isDevelopment ? 30_000 : 300_000, // 30s dev, 5min prod
  });
  console.log("[linch] CacheManager created (event-driven invalidation enabled)");

  healthCheckRegistry.register(
    "cache",
    createCacheCheck(() => {
      const s = cacheManager.stats();
      return { hits: s.l1.hits, misses: s.l1.misses, size: s.l1.size };
    }),
  );
  console.log(
    `[linch] HealthCheckRegistry: ${healthCheckRegistry.list().length} check(s) registered (${healthCheckRegistry.list().join(", ")})`,
  );

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
    automationEngine,
    aiBoundary,
    aiAuditLogger,
    aiService,
    aiConfig: config.ai,
  };

  return {
    transportCtx,
    restateEndpoint,
    outboxWorker,
    automationEngine,
    automationsStarted,
  };
}
