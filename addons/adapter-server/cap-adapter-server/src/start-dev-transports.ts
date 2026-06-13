/**
 * Dev transport bridge — starts capability-contributed transports OTHER than
 * the main HTTP server on the `bun run dev:server` path.
 *
 * Background
 * ----------
 * `bun run dev:server` (this package's `src/dev.ts`) assembles the runtime and
 * starts the HTTP/GraphQL server directly via `createServer(...)` +
 * `server.listen(port)`. It historically ignored every OTHER transport a
 * capability contributes through the generic `extensions.transports` seam — so
 * with the purchase demo config (which registers `cap-adapter-mcp` with the SSE
 * transport on :3002) the MCP channel was simply never mounted in dev (#573).
 *
 * The canonical `linch dev` CLI path (packages/cli/src/commands/dev.ts) already
 * iterates `collectCapabilityDefinitions(...).transports` and calls
 * `transport.factory(transportCtx)` → `lifecycle.start()` for each one. This
 * helper brings the SAME generic seam to the dev-server entry point WITHOUT a
 * hard runtime import of cap-adapter-mcp: the MCP transport factory rides in on
 * the loaded capability list, exactly like it does under `linch dev`.
 *
 * The HTTP transport ("http", contributed by cap-adapter-server itself) is
 * deliberately skipped here — `dev.ts` already binds the HTTP server on its
 * port, and re-starting the http transport factory would double-bind it.
 */

import type {
  CapabilityDefinition,
  LinchKitConfig,
  OntologyRegistry,
  TransportAdapterDefinition,
  TransportContext,
  TransportLifecycle,
} from "@linchkit/core";
import { ConfigRegistry } from "@linchkit/core";
import type { EvolutionRuntime } from "@linchkit/core/server";
import {
  AIAuditLogger,
  AIBoundary,
  consoleLogger,
  createNoopAIService,
  DefaultOverlayRegistry,
  InMemoryOverlayStore,
} from "@linchkit/core/server";
import type { AssembledDevSchema } from "./assemble-schema";
import { getSharedProposalEngine } from "./proposal-api";

/** Transport name owned by cap-adapter-server — its HTTP server is started directly by dev.ts. */
const HTTP_TRANSPORT_NAME = "http";

/** Inputs needed to bridge the assembled dev runtime into a TransportContext. */
export interface StartDevTransportsInput {
  /** Raw loaded config — used to build the ConfigRegistry transports read from. */
  config: LinchKitConfig;
  /** Loaded capability definitions (carry `extensions.transports`). */
  capabilities: CapabilityDefinition[];
  /** The assembled dev schema (runtime context, contributions). */
  assembled: AssembledDevSchema;
  /** Unified semantic layer (already built by dev.ts). */
  ontologyRegistry: OntologyRegistry;
  /** Evolution runtime (already built by dev.ts) — surfaces InsightEngine to MCP. */
  evolutionRuntime: EvolutionRuntime;
}

/**
 * Collect transports contributed by capabilities, excluding the HTTP transport
 * (started directly by dev.ts) so we never double-bind the HTTP port.
 */
export function collectDevTransports(
  capabilities: CapabilityDefinition[],
): TransportAdapterDefinition[] {
  const transports: TransportAdapterDefinition[] = [];
  for (const cap of capabilities) {
    if (!cap.extensions?.transports) continue;
    for (const transport of cap.extensions.transports) {
      if (transport.name === HTTP_TRANSPORT_NAME) continue;
      transports.push(transport);
    }
  }
  return transports;
}

/**
 * Build a TransportContext from the assembled dev runtime.
 *
 * Mirrors the subset of `dev-wiring.ts`'s `transportCtx` that the dev-server
 * path can supply DB-free. Transport factories (e.g. cap-adapter-mcp) read
 * `commandLayer`, `executor`, `entityRegistry`, `ontologyRegistry`,
 * `executionLogger`, `evolutionRuntime`, `overlayRegistry`, the AI boundary
 * helpers, and — for their declarative config — `config` (a ConfigRegistry).
 *
 * `overlayRegistry` is an in-memory instance here (no DB on the dev-server
 * path); MCP introspection still resolves and simply reports no overlay fields.
 */
export async function buildDevTransportContext(
  input: StartDevTransportsInput,
): Promise<TransportContext> {
  const { config, capabilities, assembled, ontologyRegistry, evolutionRuntime } = input;
  const { runtime, contributions } = assembled;

  // ConfigRegistry — resolves env vars + applies Zod defaults so a transport's
  // `config.from(ctx)` accessor (e.g. capAdapterMcpConfig.from) returns the
  // capability's declared config (transport: "sse", ssePort: 3002 in the demo).
  const configRegistry = ConfigRegistry.create(config, capabilities);

  // In-memory overlay registry — matches the dev-server path's DB-free shape.
  // Transports treat it as optional; MCP introspection resolves it and reports
  // no overlay fields when none are registered.
  const overlayRegistry = new DefaultOverlayRegistry(new InMemoryOverlayStore());
  await overlayRegistry.initialize();

  // AI boundary + audit logger — the MCP adapter wires these into its AI
  // security tools. Mirrors dev-wiring.ts so AI calls made through non-HTTP
  // transports (MCP) are audited and their usage logged, closing the
  // observability gap a bare construction would leave versus the `linch dev` path.
  const aiAuditLogger = new AIAuditLogger({
    onAuditEntry: (entry) => {
      consoleLogger.debug(
        `AI audit: ${entry.eventType} risk=${entry.riskLevel}${entry.actionName ? ` action=${entry.actionName}` : ""}`,
      );
    },
  });
  const aiBoundary = new AIBoundary({
    aiService: runtime.ai ?? createNoopAIService(),
    onUsageRecord: (record) => {
      // Forward usage records to the audit logger as AI call events.
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

  return {
    commandLayer: runtime.commandLayer,
    executor: runtime.executor,
    entityRegistry: runtime.entityRegistry,
    entities: contributions.entities,
    actions: assembled.allActions,
    views: contributions.views,
    states: contributions.states,
    middlewares: contributions.middlewares,
    config: configRegistry,
    dataProvider: runtime.dataProvider,
    eventBus: runtime.eventBus,
    executionLogger: runtime.executionLogger,
    approvalEngine: runtime.approvalEngine,
    links: contributions.relations,
    capabilities,
    ontologyRegistry,
    overlayRegistry,
    aiBoundary,
    aiAuditLogger,
    aiService: runtime.ai,
    aiConfig: config.ai,
    evolutionRuntime,
    // The SAME governed engine `/api/proposals` reads from — so AI drafts
    // created over the MCP channel (create_proposal / resolve_schema_intent)
    // surface in the review pipeline, not a throwaway instance (issue #583).
    proposalEngine: getSharedProposalEngine(),
  };
}

/**
 * Start every capability-contributed transport except the HTTP server.
 *
 * Non-throwing per-transport: a single transport that fails to start is logged
 * and skipped so the HTTP dev server (already listening) stays up — mirroring
 * the `linch dev` CLI path's per-transport try/catch.
 *
 * @returns The started lifecycle handles (for graceful shutdown by the caller).
 */
export async function startDevTransports(
  input: StartDevTransportsInput,
): Promise<TransportLifecycle[]> {
  const transports = collectDevTransports(input.capabilities);
  if (transports.length === 0) return [];

  // Context creation can throw (e.g. ConfigRegistry validation). The HTTP dev
  // server is already listening by this point, so a failure here must not crash
  // the process — log and skip all transports, mirroring the per-transport
  // non-throwing contract below.
  let transportCtx: TransportContext;
  try {
    transportCtx = await buildDevTransportContext(input);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    consoleLogger.error(`Failed to build dev transport context: ${error.message}`, {
      error: error.stack,
    });
    return [];
  }
  const lifecycles: TransportLifecycle[] = [];

  for (const transport of transports) {
    try {
      consoleLogger.info(`Starting transport: ${transport.label ?? transport.name}...`);
      const lifecycle = await transport.factory(transportCtx);
      await lifecycle.start();
      lifecycles.push(lifecycle);
      consoleLogger.info(`Transport ${transport.name} started.`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      consoleLogger.error(`Failed to start transport "${transport.name}": ${error.message}`, {
        error: error.stack,
      });
    }
  }

  return lifecycles;
}
