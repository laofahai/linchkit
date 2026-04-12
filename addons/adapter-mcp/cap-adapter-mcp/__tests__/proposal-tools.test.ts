/**
 * Tests for proposal MCP tools and execution log MCP tools.
 *
 * Verifies that the tools correctly delegate to ProposalEngine and
 * ExecutionLogger, and that proposals are always created in "draft" status.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createProposalEngine, InMemoryExecutionLogger } from "@linchkit/core/server";
import type { ExecutionLogEntry } from "@linchkit/core/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerExecutionLogTools } from "../src/execution-log-tools";
import { registerProposalTools } from "../src/proposal-tools";

// ── Test helpers ────────────────────────────────────────

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

type ToolsMap = Record<string, RegisteredTool>;

function getTools(server: unknown): ToolsMap {
  return (server as { _registeredTools: ToolsMap })._registeredTools;
}

function parseToolResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0]?.text ?? "");
}

function createTestLogEntry(overrides?: Partial<ExecutionLogEntry>): ExecutionLogEntry {
  return {
    id: overrides?.id ?? "exec-001",
    action: overrides?.action ?? "create_order",
    entity: overrides?.entity ?? "order",
    actor: overrides?.actor ?? { type: "user", id: "user-1", name: "Test User" },
    input: overrides?.input ?? { customer: "Acme" },
    output: overrides?.output ?? { id: "order-1" },
    status: overrides?.status ?? "succeeded",
    duration: overrides?.duration ?? 42,
    startedAt: overrides?.startedAt ?? new Date("2026-04-09T10:00:00Z"),
    completedAt: overrides?.completedAt ?? new Date("2026-04-09T10:00:00.042Z"),
    channel: overrides?.channel ?? "mcp",
    ...overrides,
  };
}

// ── Proposal tools tests ────────────────────────────────

describe("registerProposalTools", () => {
  let server: McpServer;
  let proposalEngine: ReturnType<typeof createProposalEngine>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    proposalEngine = createProposalEngine();
    registerProposalTools(server, proposalEngine);
  });

  test("registers four proposal tools", () => {
    const tools = getTools(server);
    expect(tools.create_proposal).toBeDefined();
    expect(tools.get_proposal_status).toBeDefined();
    expect(tools.list_proposals).toBeDefined();
    expect(tools.approve_proposal).toBeDefined();
  });

  test("create_proposal creates a proposal in draft status", async () => {
    const tools = getTools(server);
    const result = await tools.create_proposal?.handler(
      {
        title: "Add priority field to task",
        description: "Adds a priority enum field to the task entity",
        capability: "task_management",
        changeType: "minor",
        changes: [
          {
            target: "entity",
            operation: "update",
            name: "task",
            diff: "Add priority field",
          },
        ],
      },
      {},
    );

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.status).toBe("draft");
    expect(parsed.title).toBe("Add priority field to task");
    expect(parsed.capability).toBe("task_management");
    expect(parsed.changeType).toBe("minor");
    expect(parsed.id).toBeDefined();
    expect(parsed.createdAt).toBeDefined();
    expect(result.isError).toBeUndefined();
  });

  test("create_proposal auto-calculates impact", async () => {
    const tools = getTools(server);
    const result = await tools.create_proposal?.handler(
      {
        title: "Add new rule",
        description: "Add validation rule",
        capability: "orders",
        changeType: "patch",
        changes: [
          { target: "rule", operation: "create", name: "validate_amount" },
          { target: "entity", operation: "update", name: "order" },
        ],
      },
      {},
    );

    const parsed = parseToolResult(result) as Record<string, unknown>;
    const impact = parsed.impact as Record<string, unknown>;
    expect(impact.rulesAffected).toContain("validate_amount");
    expect(impact.schemasAffected).toContain("order");
  });

  test("get_proposal_status returns proposal details", async () => {
    const tools = getTools(server);

    // Create a proposal first
    const createResult = await tools.create_proposal?.handler(
      {
        title: "Test proposal",
        description: "Testing get status",
        capability: "test_cap",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "test_entity" }],
      },
      {},
    );

    const created = parseToolResult(createResult) as Record<string, unknown>;
    const proposalId = created.id as string;

    // Get its status
    const statusResult = await tools.get_proposal_status?.handler({ proposalId }, {});

    const status = parseToolResult(statusResult) as Record<string, unknown>;
    expect(status.id).toBe(proposalId);
    expect(status.title).toBe("Test proposal");
    expect(status.status).toBe("draft");
    expect(status.description).toBe("Testing get status");
    expect(statusResult.isError).toBeUndefined();
  });

  test("get_proposal_status returns error for unknown ID", async () => {
    const tools = getTools(server);
    const result = await tools.get_proposal_status?.handler({ proposalId: "nonexistent-id" }, {});

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.error).toBe("Operation failed");
  });

  test("list_proposals returns all proposals when no filter", async () => {
    const tools = getTools(server);

    // Create two proposals
    await tools.create_proposal?.handler(
      {
        title: "Proposal A",
        description: "First",
        capability: "cap_a",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "entity_a" }],
      },
      {},
    );
    await tools.create_proposal?.handler(
      {
        title: "Proposal B",
        description: "Second",
        capability: "cap_b",
        changeType: "minor",
        changes: [{ target: "action", operation: "create", name: "do_thing" }],
      },
      {},
    );

    const result = await tools.list_proposals?.handler({}, {});
    const parsed = parseToolResult(result) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(2);
  });

  test("list_proposals filters by status", async () => {
    const tools = getTools(server);

    await tools.create_proposal?.handler(
      {
        title: "Draft proposal",
        description: "Stays in draft",
        capability: "cap_a",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "entity_a" }],
      },
      {},
    );

    // All proposals start as draft, so filtering by "approved" should return empty
    const result = await tools.list_proposals?.handler({ status: "approved" }, {});
    const parsed = parseToolResult(result) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(0);

    // Filtering by "draft" should return 1
    const draftResult = await tools.list_proposals?.handler({ status: "draft" }, {});
    const draftParsed = parseToolResult(draftResult) as Array<Record<string, unknown>>;
    expect(draftParsed.length).toBe(1);
  });

  test("list_proposals filters by capability", async () => {
    const tools = getTools(server);

    await tools.create_proposal?.handler(
      {
        title: "Cap A",
        description: "For cap_a",
        capability: "cap_a",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "entity_a" }],
      },
      {},
    );
    await tools.create_proposal?.handler(
      {
        title: "Cap B",
        description: "For cap_b",
        capability: "cap_b",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "entity_b" }],
      },
      {},
    );

    const result = await tools.list_proposals?.handler({ capability: "cap_a" }, {});
    const parsed = parseToolResult(result) as Array<Record<string, unknown>>;
    expect(parsed.length).toBe(1);
    expect(parsed[0]?.capability).toBe("cap_a");
  });

  test("create_proposal always sets AI author", async () => {
    const tools = getTools(server);
    const result = await tools.create_proposal?.handler(
      {
        title: "AI proposal",
        description: "Created by AI agent",
        capability: "test",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "test" }],
      },
      {},
    );

    const parsed = parseToolResult(result) as Record<string, unknown>;
    const proposalId = parsed.id as string;

    // Verify via engine directly that author is AI
    const proposal = proposalEngine.getProposal(proposalId);
    expect(proposal.author.type).toBe("ai");
    expect(proposal.author.id).toBe("mcp-agent");
  });

  // ── approve_proposal tests ──────────────────────────

  test("approve_proposal moves a validated proposal to approved", async () => {
    const tools = getTools(server);

    // Create a draft proposal with a valid event definition (validation passes
    // for events that just need a name).
    const createResult = await tools.create_proposal?.handler(
      {
        title: "Approve me",
        description: "Will be approved",
        capability: "approval_test",
        changeType: "patch",
        changes: [
          {
            target: "event",
            operation: "create",
            name: "thing_created",
            definition: { name: "thing_created", category: "domain" },
          },
        ],
      },
      {},
    );
    const created = parseToolResult(createResult) as Record<string, unknown>;
    const proposalId = created.id as string;

    // Move draft → validated via the engine directly (validation is a separate step
    // not exposed as an MCP tool here)
    proposalEngine.submitProposal({ proposalId });
    expect(proposalEngine.getProposal(proposalId).status).toBe("validated");

    // Approve via MCP tool
    const approveResult = await tools.approve_proposal?.handler(
      { proposalId, reviewer: "alice" },
      {},
    );

    const approved = parseToolResult(approveResult) as Record<string, unknown>;
    expect(approveResult.isError).toBeUndefined();
    expect(approved.id).toBe(proposalId);
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toEqual({ type: "ai", id: "alice" });
    expect(approved.approvedAt).toBeDefined();
  });

  test("approve_proposal returns error for unknown ID", async () => {
    const tools = getTools(server);

    const result = await tools.approve_proposal?.handler(
      { proposalId: "missing-id", reviewer: "bob" },
      {},
    );

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.error).toContain("not found");
  });

  test("approve_proposal returns error when proposal is not validated", async () => {
    const tools = getTools(server);

    // Create draft (status = "draft", not "validated")
    const createResult = await tools.create_proposal?.handler(
      {
        title: "Still draft",
        description: "Not yet submitted",
        capability: "approval_test",
        changeType: "patch",
        changes: [{ target: "entity", operation: "create", name: "thing2" }],
      },
      {},
    );
    const created = parseToolResult(createResult) as Record<string, unknown>;
    const proposalId = created.id as string;

    const result = await tools.approve_proposal?.handler({ proposalId, reviewer: "carol" }, {});

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.error).toContain("validated");
  });

  test("approve_proposal falls back to session actor when reviewer is omitted", async () => {
    const localServer = new McpServer({ name: "approve-test", version: "1.0.0" });
    const localEngine = createProposalEngine();
    registerProposalTools(localServer, localEngine, {
      getSessionActor: () => ({
        type: "human",
        id: "session-user-42",
        name: "Session User",
      }),
    });

    const localTools = getTools(localServer);
    const createResult = await localTools.create_proposal?.handler(
      {
        title: "Session approval",
        description: "Approved by session actor",
        capability: "approval_test",
        changeType: "patch",
        changes: [
          {
            target: "event",
            operation: "create",
            name: "thing3_created",
            definition: { name: "thing3_created", category: "domain" },
          },
        ],
      },
      {},
    );
    const created = parseToolResult(createResult) as Record<string, unknown>;
    const proposalId = created.id as string;
    localEngine.submitProposal({ proposalId });
    expect(localEngine.getProposal(proposalId).status).toBe("validated");

    const approveResult = await localTools.approve_proposal?.handler({ proposalId }, {});

    const approved = parseToolResult(approveResult) as Record<string, unknown>;
    expect(approveResult.isError).toBeUndefined();
    expect(approved.approvedBy).toEqual({ type: "human", id: "session-user-42" });
  });
});

// ── Execution log tools tests ───────────────────────────

describe("registerExecutionLogTools", () => {
  let server: McpServer;
  let logger: InstanceType<typeof InMemoryExecutionLogger>;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    logger = new InMemoryExecutionLogger();
    registerExecutionLogTools(server, logger);
  });

  test("registers two execution log tools", () => {
    const tools = getTools(server);
    expect(tools.get_execution_log).toBeDefined();
    expect(tools.get_recent_executions).toBeDefined();
  });

  test("get_execution_log returns entry by ID", async () => {
    const entry = createTestLogEntry({ id: "exec-42" });
    logger.log(entry);

    const tools = getTools(server);
    const result = await tools.get_execution_log?.handler({ executionId: "exec-42" }, {});

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.id).toBe("exec-42");
    expect(parsed.action).toBe("create_order");
    expect(parsed.entity).toBe("order");
    expect(parsed.status).toBe("succeeded");
    expect(parsed.duration).toBe(42);
    expect(result.isError).toBeUndefined();
  });

  test("get_execution_log returns error for unknown ID", async () => {
    const tools = getTools(server);
    const result = await tools.get_execution_log?.handler({ executionId: "nonexistent" }, {});

    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.error).toContain("not found");
  });

  test("get_recent_executions returns all entries sorted by most recent", async () => {
    const older = createTestLogEntry({
      id: "exec-1",
      startedAt: new Date("2026-04-09T09:00:00Z"),
    });
    const newer = createTestLogEntry({
      id: "exec-2",
      startedAt: new Date("2026-04-09T10:00:00Z"),
    });
    logger.log(older);
    logger.log(newer);

    const tools = getTools(server);
    const result = await tools.get_recent_executions?.handler({}, {});

    const parsed = parseToolResult(result) as {
      total: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(2);
    expect(parsed.entries.length).toBe(2);
    // Most recent first
    expect(parsed.entries[0]?.id).toBe("exec-2");
    expect(parsed.entries[1]?.id).toBe("exec-1");
  });

  test("get_recent_executions filters by entity", async () => {
    logger.log(createTestLogEntry({ id: "exec-1", entity: "order" }));
    logger.log(createTestLogEntry({ id: "exec-2", entity: "task" }));

    const tools = getTools(server);
    const result = await tools.get_recent_executions?.handler({ entity: "order" }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0]?.entity).toBe("order");
  });

  test("get_recent_executions filters by action", async () => {
    logger.log(createTestLogEntry({ id: "exec-1", action: "create_order" }));
    logger.log(createTestLogEntry({ id: "exec-2", action: "delete_order" }));

    const tools = getTools(server);
    const result = await tools.get_recent_executions?.handler({ action: "create_order" }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0]?.action).toBe("create_order");
  });

  test("get_recent_executions filters by status", async () => {
    logger.log(createTestLogEntry({ id: "exec-1", status: "succeeded" }));
    logger.log(createTestLogEntry({ id: "exec-2", status: "failed" }));

    const tools = getTools(server);
    const result = await tools.get_recent_executions?.handler({ status: "failed" }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.entries[0]?.status).toBe("failed");
  });

  test("get_recent_executions respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      logger.log(
        createTestLogEntry({
          id: `exec-${i}`,
          startedAt: new Date(`2026-04-09T${10 + i}:00:00Z`),
        }),
      );
    }

    const tools = getTools(server);
    const result = await tools.get_recent_executions?.handler({ limit: 2 }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(5);
    expect(parsed.entries.length).toBe(2);
  });

  test("get_recent_executions clamps limit to max 100", async () => {
    const tools = getTools(server);
    // Should not throw with a large limit
    const result = await tools.get_recent_executions?.handler({ limit: 999 }, {});
    const parsed = parseToolResult(result) as {
      total: number;
      entries: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(0);
  });

  test("get_execution_log serializes dates to ISO strings", async () => {
    const entry = createTestLogEntry({
      id: "exec-date",
      startedAt: new Date("2026-04-09T12:30:00Z"),
      completedAt: new Date("2026-04-09T12:30:01Z"),
    });
    logger.log(entry);

    const tools = getTools(server);
    const result = await tools.get_execution_log?.handler({ executionId: "exec-date" }, {});

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.startedAt).toBe("2026-04-09T12:30:00.000Z");
    expect(parsed.completedAt).toBe("2026-04-09T12:30:01.000Z");
  });
});
