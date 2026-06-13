/**
 * #573 — dev:server mounts the MCP transport.
 *
 * Proves the generic `extensions.transports` seam the dev-server entry point
 * now uses (`startDevTransports`) makes the MCP channel reachable out of the
 * box with the purchase-demo-shaped config, WITHOUT binding any socket.
 *
 * Strategy (no listening socket — bound sockets segfault the batched runner):
 *   1. `collectDevTransports` includes the MCP transport, excludes the HTTP one
 *      (the HTTP server is started directly by dev.ts; re-starting its factory
 *      would double-bind the port).
 *   2. `buildDevTransportContext` over the SAME `assembleDevSchema` runtime
 *      yields a TransportContext carrying everything the MCP transport reads
 *      (commandLayer, registries, ontology, config, AI boundary helpers).
 *   3. The MCP server built from that bridged context — driven over an
 *      in-process `InMemoryTransport` (the real MCP wire, no socket) — exposes
 *      the tool surface AND blocks `approve_purchase_request` for the default
 *      `ai_agent` actor via the manager-approval threshold rule (the same proof
 *      as the #565 harness).
 *
 * The MCP transport factory is invoked too (in stdio mode, also socket-free) to
 * assert it is startable through the bridged context.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCapAdapterMcp, createMcpAdapter } from "@linchkit/cap-adapter-mcp";
import {
  type ActionDefinition,
  type CapabilityDefinition,
  type CodeCondition,
  defineAction,
  defineCapability,
  defineEntity,
  type EntityDefinition,
  type LinchKitConfig,
  type RuleDefinition,
  type StateDefinition,
} from "@linchkit/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assembleDevSchema } from "../src/assemble-schema";
import { buildDevEvolutionRuntime, buildDevOntologyRegistry } from "../src/dev-app";
import { buildDevTransportContext, collectDevTransports } from "../src/start-dev-transports";

// ── Minimal purchase capability (mirrors cap-purchase-demo's core) ────────

const THRESHOLD = 10000;

const purchaseRequestEntity: EntityDefinition = defineEntity({
  name: "purchase_request",
  label: "Purchase Request",
  description: "A purchase request awaiting approval",
  fields: {
    title: { type: "string", label: "Title", required: true },
    amount: { type: "number", label: "Amount", required: true },
    status: { type: "string", label: "Status" },
  },
});

const purchaseLifecycle: StateDefinition = {
  name: "purchase_lifecycle",
  entity: "purchase_request",
  field: "status",
  initial: "pending",
  states: ["pending", "approved", "rejected"],
  transitions: [
    { from: "pending", to: "approved", action: "approve_purchase_request" },
    { from: "pending", to: "rejected", action: "reject_purchase_request" },
  ],
};

const approveAction: ActionDefinition = defineAction({
  name: "approve_purchase_request",
  entity: "purchase_request",
  label: "Approve Purchase Request",
  description: "Approve a pending purchase request",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  stateTransition: { from: "pending", to: "approved" },
});

const MANAGER_GROUPS = ["purchase_manager", "manager", "admin"];

const overThresholdNonManager: CodeCondition = ({ actor, record }) => {
  const groups = actor.groups ?? [];
  const isManager = groups.some((g) => MANAGER_GROUPS.includes(g));
  if (record == null) return !isManager;
  const raw = (record as { amount?: unknown }).amount;
  const amount = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(amount)) return !isManager;
  if (amount <= THRESHOLD) return false;
  return !isManager;
};

const managerApprovalThresholdRule: RuleDefinition = {
  name: "manager_approval_threshold",
  label: "Manager Approval Threshold",
  description: `Purchase requests over ${THRESHOLD} may only be approved by a manager.`,
  trigger: { action: "approve_purchase_request" },
  condition: overThresholdNonManager,
  effect: {
    type: "block",
    message: `Amounts over ${THRESHOLD} require manager approval`,
  },
};

const HIGH_VALUE_ID = "pr-high-value";

const purchaseCapability: CapabilityDefinition = defineCapability({
  name: "cap-purchase-test",
  label: "Purchase (test)",
  type: "business",
  category: "demo",
  version: "0.0.1",
  entities: [purchaseRequestEntity],
  actions: [approveAction],
  states: [purchaseLifecycle],
  rules: [managerApprovalThresholdRule],
  seed: {
    purchase_request: [
      { id: HIGH_VALUE_ID, title: "New laptops", amount: 25000, status: "pending" },
    ],
  },
});

// ── Demo-shaped config: adapter-server-less, MCP in SSE mode on :3002 ──────
// (We never start the SSE socket here; the SSE config just proves the
//  ConfigRegistry carries the declared transport mode through the bridge.)

const mcpCapability = createCapAdapterMcp({ config: { transport: "sse", ssePort: 3002 } });

const capabilities: CapabilityDefinition[] = [mcpCapability, purchaseCapability];

const config: LinchKitConfig = {
  server: { port: 3001, host: "0.0.0.0" },
  capabilities,
};

// ── Boot the SAME assembleDevSchema runtime dev.ts uses ───────────────────

let client: Client;
let assembled: ReturnType<typeof assembleDevSchema>;

beforeAll(async () => {
  assembled = assembleDevSchema(capabilities);

  // Seed the in-memory store from capability seed data (dev.ts does this too).
  const { InMemoryStore } = await import("@linchkit/core/server");
  if (assembled.runtime.dataProvider instanceof InMemoryStore) {
    for (const [entity, records] of Object.entries(assembled.contributions.seed)) {
      assembled.runtime.dataProvider.seed(entity, records);
    }
  }

  const ontologyRegistry = buildDevOntologyRegistry(assembled);
  const evolutionRuntime = buildDevEvolutionRuntime({
    capabilities,
    assembled,
    ontologyRegistry,
  });

  // The exact bridge dev.ts now performs to start non-HTTP transports.
  const transportCtx = await buildDevTransportContext({
    config,
    capabilities,
    assembled,
    ontologyRegistry,
    evolutionRuntime,
  });

  // The bridged context MUST carry the shared governed proposal engine: the MCP
  // transport factory gates create_proposal / resolve_schema_intent on it, so a
  // missing proposalEngine silently de-activates those tools in the dev MCP path
  // (issue #583). Pin it here so a regression fails loudly rather than going dark.
  expect(transportCtx.proposalEngine).toBeDefined();

  // Build the MCP server from the bridged context — same args the MCP transport
  // factory passes — and drive it over an in-process JSON-RPC pipe (no socket).
  const { server } = await createMcpAdapter({
    commandLayer: transportCtx.commandLayer,
    entityRegistry: transportCtx.entityRegistry,
    // biome-ignore lint/style/noNonNullAssertion: bridged context always sets executor
    actionRegistry: transportCtx.executor!.registry,
    ontologyRegistry: transportCtx.ontologyRegistry,
    aiBoundary: transportCtx.aiBoundary,
    aiAuditLogger: transportCtx.aiAuditLogger,
    executionLogger: transportCtx.executionLogger,
    overlayRegistry: transportCtx.overlayRegistry,
    name: "linchkit",
    version: "1.0.0",
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "dev-mcp-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  if (client) await client.close();
});

describe("#573 dev:server mounts the MCP transport via the generic seam", () => {
  test("collectDevTransports includes MCP and excludes the HTTP transport", () => {
    const transports = collectDevTransports(capabilities);
    const names = transports.map((t) => t.name);
    expect(names).toContain("mcp");
    expect(names).not.toContain("http");
  });

  test("the MCP transport factory is startable through the bridged context (stdio, no socket)", async () => {
    const ontologyRegistry = buildDevOntologyRegistry(assembled);
    const evolutionRuntime = buildDevEvolutionRuntime({
      capabilities,
      assembled,
      ontologyRegistry,
    });

    // stdio mode keeps this socket-free; the SSE-mode demo capability carries a
    // socket factory, so build a transient stdio MCP capability for the start
    // assertion instead of binding :3002.
    const stdioMcp = createCapAdapterMcp({ config: { transport: "stdio" } });
    const transport = stdioMcp.extensions?.transports?.find((t) => t.name === "mcp");
    expect(transport).toBeDefined();

    const ctx = await buildDevTransportContext({
      config: { ...config, capabilities: [stdioMcp, purchaseCapability] },
      capabilities: [stdioMcp, purchaseCapability],
      assembled,
      ontologyRegistry,
      evolutionRuntime,
    });

    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const lifecycle = await transport!.factory(ctx);
    expect(typeof lifecycle.start).toBe("function");
    expect(typeof lifecycle.stop).toBe("function");
    // Do NOT call start() — stdio start binds process stdio. Building the
    // lifecycle through the bridged context already proves the seam carries
    // everything the factory needs.
  });

  test("MCP tool surface is reachable (entity + approve action + introspection)", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("approve_purchase_request");
    expect(names).toContain("list_entities");
    expect(names).toContain("list_actions");

    const entities = await client.callTool({ name: "list_entities", arguments: {} });
    const content = entities.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]?.text ?? "[]") as Array<{ name: string }>;
    expect(parsed.some((e) => e.name === "purchase_request")).toBe(true);
  });

  test("approve_purchase_request as the default ai_agent actor is BLOCKED by the threshold rule", async () => {
    const result = await client.callTool({
      name: "approve_purchase_request",
      arguments: { id: HIGH_VALUE_ID },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]?.text ?? "{}") as {
      success?: boolean;
      data?: { error?: string; context?: { constraint?: string } };
    };

    // The MCP default actor is `{ type: "ai", groups: ["ai_agent"] }` — not a
    // manager — so the manager-approval-threshold rule blocks the over-threshold
    // request before any write (same proof as the #565 harness). A rule block
    // surfaces as `{ success: false, data: { error, context.constraint } }`.
    expect(parsed.success).toBe(false);
    expect(parsed.data?.context?.constraint).toBe("rule_block");
    expect(parsed.data?.error ?? "").toContain("manager approval");
  });
});
