/**
 * Admin / metadata REST endpoints.
 *
 * - GET /health
 * - GET /api/metrics
 * - GET /api/app-config
 * - GET /api/tenants
 * - GET /api/settings
 * - GET /api/rules, GET /api/rules/:name
 * - GET /api/flows, GET /api/flows/:name
 * - POST /api/flows/:name/start — manually trigger a flow
 * - GET /api/flows/:name/status/:instanceId — query flow instance status
 * - GET /api/states, GET /api/states/:name
 * - GET /api/executions, GET /api/executions/:id
 * - GET /api/links — all registered link definitions (for relation graph)
 * - GET /api/semantic-relations — inferred semantic relations between capabilities/schemas
 * - GET /internal/cache/stats — cache hit rate, eviction rate, memory usage (spec §9)
 */

import type {
  ExecutionStatus,
  FlowDefinition,
  RelationDefinition,
  StateDefinition,
} from "@linchkit/core";
import { buildRelationGraph } from "@linchkit/core";
import { type CacheManager, DrizzleDataProvider, InMemoryStore } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import {
  badRequest,
  collectFromCapabilities,
  notFound,
  serverError,
  serviceUnavailable,
} from "./shared";

export function mountAdminRoutes(
  app: Elysia,
  options: ServerOptions,
  serverStartedAt: number,
): void {
  const entityRegistry = options.entityRegistry;
  const capabilities = options.capabilities ?? [];
  const healthCheckRegistry = options.healthCheckRegistry;
  const metricsCollector = options.metricsCollector;
  const aiService = options.aiService;
  const tenants = options.tenants ?? [];
  const rules = options.rules ?? [];
  const linchKitConfig = options.linchKitConfig;
  const _dataProvider = options.dataProvider;
  const executionLogger = options.executionLogger;

  app
    // Health check — runs all registered probes when HealthCheckRegistry is provided
    .get("/health", async ({ set }) => {
      const system = {
        version: "0.2.0",
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform,
        schemaCount: entityRegistry?.getAll().length ?? 0,
        capabilityCount: capabilities.length,
      };
      const metrics = metricsCollector
        ? {
            actionCount:
              metricsCollector.getCounter("action.executed") +
              metricsCollector.getCounter("command.processed"),
            ruleBlockCount: metricsCollector.getCounter("rule.block_count"),
            eventCount: metricsCollector.getCounter("event.emitted"),
          }
        : undefined;
      if (healthCheckRegistry) {
        const result = await healthCheckRegistry.runAll();
        // Return 503 when any check is unhealthy so load balancers can route away
        if (result.status === "unhealthy") {
          set.status = 503;
        }
        return {
          status: result.status,
          checks: result.checks,
          timestamp: result.timestamp,
          system,
          ...(metrics !== undefined && { metrics }),
        };
      }
      // Fallback: basic liveness response when no registry is configured
      return {
        status: "healthy",
        checks: [],
        timestamp: new Date().toISOString(),
        system,
        ...(metrics !== undefined && { metrics }),
      };
    })
    // Metrics summary endpoint — returns aggregated metrics from the collector
    .get("/api/metrics", () => {
      if (!metricsCollector) {
        return { success: false, error: "No metrics collector configured" };
      }
      return {
        success: true,
        data: metricsCollector.getSummary(),
        timestamp: new Date().toISOString(),
      };
    })
    // App config — tells the UI which capabilities are loaded and their pages/menus
    .get("/api/app-config", () => {
      const authEnabled = capabilities.some((c) => c.name === "cap-auth");
      const aiEnabled = !!aiService?.configured;
      const pages = capabilities.flatMap((c) => c.pages ?? []);
      const menuItems = capabilities.flatMap((c) => c.extensions?.menuItems ?? []);
      return {
        success: true,
        data: {
          authEnabled,
          aiEnabled,
          capabilities: capabilities.map((c) => c.name),
          pages,
          menuItems,
        },
      };
    })
    // Tenant list — consumed by TenantSwitcher UI component
    .get("/api/tenants", () => {
      return { success: true, data: tenants };
    })
    // Settings — sanitized system configuration for admin UI
    .get("/api/settings", async () => {
      const cfg = linchKitConfig;
      const dp = options.dataProvider;
      const uptimeMs = Date.now() - serverStartedAt;
      const actionCount = capabilities.reduce((sum, c) => sum + (c.actions?.length ?? 0), 0);
      const linkCount = capabilities.reduce((sum, c) => sum + (c.relations?.length ?? 0), 0);
      const eventHandlerCount = capabilities.reduce(
        (sum, c) => sum + (c.eventHandlers?.length ?? 0),
        0,
      );

      // Determine real database status from the actual DataProvider instance
      let dbConnected = false;
      let dbProvider: string = "none";
      if (dp instanceof DrizzleDataProvider) {
        dbProvider = "postgresql";
        dbConnected = await dp.ping();
      } else if (dp instanceof InMemoryStore) {
        dbProvider = "in-memory";
        dbConnected = true;
      } else if (dp) {
        dbProvider = "custom";
        dbConnected = true;
      }

      // Build per-capability resource breakdown
      const capabilityDetails = capabilities.map((c) => ({
        name: c.name,
        type: c.type ?? "standard",
        label: c.label,
        description: c.description,
        entities: c.entities?.length ?? 0,
        actions: c.actions?.length ?? 0,
        rules: c.rules?.length ?? 0,
        flows: c.flows?.length ?? 0,
        states: c.states?.length ?? 0,
        relations: c.relations?.length ?? 0,
        eventHandlers: c.eventHandlers?.length ?? 0,
        pages: c.pages?.length ?? 0,
        menuItems: c.extensions?.menuItems?.length ?? 0,
      }));

      // Sanitize: never expose secrets, tokens, passwords, connection URLs
      const settings = {
        general: {
          version: "0.2.0",
          uptime: uptimeMs,
          registeredSchemas: entityRegistry?.getAll().length ?? 0,
          registeredActions: actionCount,
          registeredRules: rules.length,
          registeredFlows:
            options.flows?.length ??
            capabilities.reduce((sum, c) => sum + (c.flows?.length ?? 0), 0),
          registeredStates:
            options.states?.length ??
            capabilities.reduce((sum, c) => sum + (c.states?.length ?? 0), 0),
          registeredLinks: linkCount,
          registeredEventHandlers: eventHandlerCount,
          capabilityCount: capabilities.length,
          capabilities: capabilities.map((c) => c.name),
          capabilityDetails,
        },
        database: {
          configured: dbConnected,
          provider: dbProvider,
          poolSize: cfg?.database?.poolSize ?? (dbProvider === "postgresql" ? 10 : null),
          debug: cfg?.database?.debug ?? false,
        },
        ai: {
          configured: !!aiService?.configured,
          defaultProvider: aiService?.defaultProvider ?? null,
          providers: aiService?.providerNames ?? [],
        },
        auth: {
          enabled: capabilities.some((c) => c.name === "cap-auth"),
          provider: capabilities.find((c) => c.name.startsWith("cap-auth-"))?.name ?? null,
        },
        tenancy: {
          mode: tenants.length > 0 ? "multi" : "standalone",
          tenantCount: tenants.length,
        },
        server: {
          port: cfg?.server?.port ?? 3001,
          host: cfg?.server?.host ?? "localhost",
        },
        subscription: {
          enabled: cfg?.subscription?.enabled ?? true,
          maxConnectionsPerUser: cfg?.subscription?.maxConnectionsPerUser ?? 3,
          heartbeatInterval: cfg?.subscription?.heartbeatInterval ?? 30000,
          idleTimeout: cfg?.subscription?.idleTimeout ?? 300000,
          maxBufferSize: cfg?.subscription?.maxBufferSize ?? 100,
        },
        flow: {
          configured: true,
          engine: cfg?.flow?.restate ? "restate" : "sync",
        },
      };

      return { success: true, data: settings };
    })
    // Rule definition endpoints — consumed by Rules management UI
    .get("/api/rules", ({ query }) => {
      let filtered = rules;
      const entityFilter = (query.entity ?? query.schema) as string | undefined;
      if (entityFilter && typeof entityFilter === "string") {
        const schemaFilter = entityFilter;
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          if ("stateChange" in trigger) return trigger.stateChange.entity === schemaFilter;
          if ("fieldChange" in trigger) return trigger.fieldChange.entity === schemaFilter;
          if ("action" in trigger) {
            const actions = Array.isArray(trigger.action) ? trigger.action : [trigger.action];
            return actions.some((a) => a.includes(schemaFilter));
          }
          return false;
        });
      }
      if (query.triggerType && typeof query.triggerType === "string") {
        const tt = query.triggerType;
        filtered = filtered.filter((r) => {
          const trigger = r.trigger;
          if (tt === "action") return "action" in trigger;
          if (tt === "stateChange") return "stateChange" in trigger;
          if (tt === "fieldChange") return "fieldChange" in trigger;
          if (tt === "event") return "event" in trigger;
          if (tt === "schedule") return "schedule" in trigger;
          return true;
        });
      }
      const serialized = filtered.map((r) => ({
        name: r.name,
        label: r.label,
        description: r.description,
        priority: r.priority ?? 0,
        trigger: r.trigger,
        condition: typeof r.condition === "function" ? { type: "code" } : r.condition,
        effect: r.effect,
      }));
      return { success: true, data: serialized };
    })
    .get("/api/rules/:name", ({ params, set }) => {
      const rule = rules.find((r) => r.name === params.name);
      if (!rule) {
        return notFound(set, `Rule "${params.name}" not found.`);
      }
      return {
        success: true,
        data: {
          name: rule.name,
          label: rule.label,
          description: rule.description,
          priority: rule.priority ?? 0,
          trigger: rule.trigger,
          condition: typeof rule.condition === "function" ? { type: "code" } : rule.condition,
          effect: rule.effect,
        },
      };
    })
    // ── Execution Log REST endpoints ────────────────────────
    .get("/api/executions", async ({ query, set }) => {
      if (!executionLogger) {
        return serverError(set, "Execution logger not configured.");
      }

      // Validate date parameters
      const ISO_DATE_RE =
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      if (query.since && !ISO_DATE_RE.test(query.since as string)) {
        return badRequest(set, "Invalid 'since' date format.");
      }
      if (query.until && !ISO_DATE_RE.test(query.until as string)) {
        return badRequest(set, "Invalid 'until' date format.");
      }

      // Validate and clamp pagination
      let page = query.page ? Number(query.page) : undefined;
      let pageSize = query.pageSize ? Number(query.pageSize) : undefined;
      if (page !== undefined) {
        if (Number.isNaN(page)) {
          return badRequest(set, "Invalid 'page' parameter.");
        }
        page = Math.max(1, Math.floor(page));
      }
      if (pageSize !== undefined) {
        if (Number.isNaN(pageSize)) {
          return badRequest(set, "Invalid 'pageSize' parameter.");
        }
        pageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
      }

      try {
        const result = await executionLogger.findMany({
          action: query.action as string | undefined,
          entity: (query.entity ?? query.schema) as string | undefined,
          status: query.status as ExecutionStatus | undefined,
          actorId: query.actorId as string | undefined,
          since: query.since as string | undefined,
          until: query.until as string | undefined,
          page,
          pageSize,
          sortField: query.sortField as "startedAt" | "duration" | "action" | undefined,
          sortOrder: query.sortOrder as "asc" | "desc" | undefined,
        });
        return { success: true, data: result };
      } catch (err) {
        const message =
          process.env.NODE_ENV === "production"
            ? "Failed to query execution logs."
            : err instanceof Error
              ? err.message
              : String(err);
        return serverError(set, message);
      }
    })
    .get("/api/executions/:id", async ({ params, set }) => {
      if (!executionLogger) {
        return serverError(set, "Execution logger not configured.");
      }
      const entry = await executionLogger.getById(params.id);
      if (!entry) {
        return notFound(set, `Execution ${params.id} not found.`);
      }
      return { success: true, data: entry };
    })
    // ── Flow REST endpoints ──────────────────────────────────
    .get("/api/flows", () => {
      const allFlows = collectFromCapabilities<FlowDefinition>(
        options.flows,
        capabilities,
        "flows",
      );
      const summary = allFlows.map((f) => ({
        name: f.name,
        label: f.label,
        description: f.description,
        version: f.version,
        trigger: f.trigger,
        stepCount: f.steps.length,
        steps: f.steps.map((s) => ({ id: s.id, name: s.name, type: s.type })),
      }));
      return { success: true, data: summary };
    })
    .get("/api/flows/:name", ({ params, set }) => {
      const allFlows = collectFromCapabilities<FlowDefinition>(
        options.flows,
        capabilities,
        "flows",
      );
      const flow = allFlows.find((f) => f.name === params.name);
      if (!flow) {
        return notFound(set, `Flow "${params.name}" not found.`);
      }
      return { success: true, data: flow };
    })
    // ── Flow execution endpoints ────────────────────────────
    .post("/api/flows/:name/start", async ({ params, body, set }) => {
      const flowEngine = options.flowEngine;
      if (!flowEngine) {
        return serviceUnavailable(set, "Flow engine not available");
      }

      // Verify flow exists
      const allFlows = collectFromCapabilities<FlowDefinition>(
        options.flows,
        capabilities,
        "flows",
      );
      const flow = allFlows.find((f) => f.name === params.name);
      if (!flow) {
        return notFound(set, `Flow "${params.name}" not found.`);
      }

      try {
        const input = (body as Record<string, unknown>) ?? {};
        const instance = await flowEngine.startFlow(params.name, input);
        return { success: true, data: instance };
      } catch (err) {
        return serverError(set, err instanceof Error ? err.message : String(err));
      }
    })
    .get("/api/flows/:name/status/:instanceId", async ({ params, set }) => {
      const flowEngine = options.flowEngine;
      if (!flowEngine) {
        return serviceUnavailable(set, "Flow engine not available");
      }

      const instance = await flowEngine.getFlowStatus(params.instanceId);
      if (!instance) {
        return notFound(set, `Flow instance "${params.instanceId}" not found.`);
      }
      return { success: true, data: instance };
    })
    // ── State Machine REST endpoints ─────────────────────────
    .get("/api/states", () => {
      const allStates = collectFromCapabilities<StateDefinition>(
        options.states,
        capabilities,
        "states",
      );
      const summary = allStates.map((s) => ({
        name: s.name,
        schema: s.entity,
        field: s.field,
        initial: s.initial,
        stateCount: s.states.length,
        transitionCount: s.transitions.length,
        states: s.states,
        meta: s.meta,
      }));
      return { success: true, data: summary };
    })
    .get("/api/states/:name", ({ params, set }) => {
      const allStates = collectFromCapabilities<StateDefinition>(
        options.states,
        capabilities,
        "states",
      );
      const state = allStates.find((s) => s.name === params.name);
      if (!state) {
        return notFound(set, `State machine "${params.name}" not found.`);
      }
      return { success: true, data: state };
    })
    // ── Link REST endpoints ─────────────────────────────────
    .get("/api/links", () => {
      const allLinks = collectFromCapabilities<RelationDefinition>(
        undefined,
        capabilities,
        "relations",
      );
      return { success: true, data: allLinks };
    })
    // ── Semantic relation endpoint ──────────────────────────
    .get("/api/semantic-relations", () => {
      const graph = buildRelationGraph(capabilities);
      return { success: true, data: graph.relations };
    })
    // ── Cache stats endpoint (spec §9) ─────────────────────
    .get("/internal/cache/stats", () => {
      const cacheManager = options.cacheManager as CacheManager | undefined;
      if (!cacheManager) {
        return { success: false, error: "No cache manager configured" };
      }

      const raw = cacheManager.stats();
      const l1 = raw.l1;
      const l2 = raw.l2;

      // Compute eviction rate: evictions / (hits + misses + evictions) — fraction of all operations
      const l1Total = l1.hits + l1.misses;
      const l1EvictionRate =
        l1.evictions + l1Total > 0 ? l1.evictions / (l1.evictions + l1Total) : 0;

      const result: Record<string, unknown> = {
        l1: {
          hits: l1.hits,
          misses: l1.misses,
          evictions: l1.evictions,
          size: l1.size,
          hitRate: l1.hitRate,
          evictionRate: l1EvictionRate,
        },
        timestamp: new Date().toISOString(),
      };

      if (l2) {
        const l2Total = l2.hits + l2.misses;
        const l2EvictionRate =
          l2.evictions + l2Total > 0 ? l2.evictions / (l2.evictions + l2Total) : 0;
        result.l2 = {
          hits: l2.hits,
          misses: l2.misses,
          evictions: l2.evictions,
          size: l2.size,
          hitRate: l2.hitRate,
          evictionRate: l2EvictionRate,
        };
      }

      return { success: true, data: result };
    });
}
