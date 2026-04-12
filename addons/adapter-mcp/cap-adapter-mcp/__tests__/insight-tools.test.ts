/**
 * Tests for the list_insights MCP tool.
 *
 * Verifies filtering by entity, type, limit slicing, and the JSON contract
 * returned to the MCP client.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Insight, InsightEngine, InsightType } from "@linchkit/core/types";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInsightTools } from "../src/insight-tools";

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

function makeInsight(overrides: Partial<Insight> & { id: string }): Insight {
  return {
    id: overrides.id,
    type: overrides.type ?? "anomaly",
    confidence: overrides.confidence ?? 0.85,
    impact: overrides.impact ?? "medium",
    causality: overrides.causality ?? "correlational",
    entity: overrides.entity ?? "purchase_request",
    summary: overrides.summary ?? "Test insight",
    createdAt: overrides.createdAt ?? new Date("2026-04-10T12:00:00Z"),
    evidence: overrides.evidence ?? {
      signals: [],
      context: {},
    },
  };
}

function createMockEngine(insights: Insight[]): InsightEngine {
  return {
    getInsights: () => insights,
    generateInsights: async () => insights,
    recordDriftCandidate: () => {
      // no-op for tests
    },
  };
}

// ── Test fixtures ───────────────────────────────────────

const INSIGHT_FIXTURES: Insight[] = [
  makeInsight({ id: "i-1", type: "anomaly", entity: "purchase_request" }),
  makeInsight({ id: "i-2", type: "friction", entity: "purchase_request" }),
  makeInsight({ id: "i-3", type: "pattern", entity: "purchase_item" }),
  makeInsight({ id: "i-4", type: "structural", entity: "purchase_item" }),
  makeInsight({ id: "i-5", type: "positive", entity: "department" }),
];

// ── Tests ───────────────────────────────────────────────

describe("registerInsightTools", () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerInsightTools(server, createMockEngine(INSIGHT_FIXTURES));
  });

  test("registers list_insights tool", () => {
    const tools = getTools(server);
    expect(tools.list_insights).toBeDefined();
  });

  test("list_insights with no filter returns all insights", async () => {
    const tools = getTools(server);
    const result = await tools.list_insights?.handler({}, {});

    const parsed = parseToolResult(result) as {
      total: number;
      returned: number;
      insights: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(5);
    expect(parsed.returned).toBe(5);
    expect(parsed.insights.length).toBe(5);
  });

  test("list_insights filters by entity", async () => {
    const tools = getTools(server);
    const result = await tools.list_insights?.handler({ entity: "purchase_request" }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      insights: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(2);
    expect(parsed.insights.every((i) => i.entity === "purchase_request")).toBe(true);
  });

  test("list_insights filters by type", async () => {
    const tools = getTools(server);
    const result = await tools.list_insights?.handler({ type: "structural" as InsightType }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      insights: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.insights[0]?.id).toBe("i-4");
    expect(parsed.insights[0]?.type).toBe("structural");
  });

  test("list_insights combines entity and type filters", async () => {
    const tools = getTools(server);
    const result = await tools.list_insights?.handler(
      { entity: "purchase_item", type: "pattern" as InsightType },
      {},
    );

    const parsed = parseToolResult(result) as {
      total: number;
      insights: Array<Record<string, unknown>>;
    };
    expect(parsed.total).toBe(1);
    expect(parsed.insights[0]?.id).toBe("i-3");
  });

  test("list_insights respects limit parameter", async () => {
    const tools = getTools(server);
    const result = await tools.list_insights?.handler({ limit: 2 }, {});

    const parsed = parseToolResult(result) as {
      total: number;
      returned: number;
      insights: Array<Record<string, unknown>>;
    };
    // total is the filtered count (5), returned is the slice length (2).
    expect(parsed.total).toBe(5);
    expect(parsed.returned).toBe(2);
    expect(parsed.insights.length).toBe(2);
  });

  test("list_insights serializes evidence baseline dates as ISO strings", async () => {
    const baselineDate = new Date("2026-03-01T00:00:00Z");
    const insight = makeInsight({
      id: "with-baseline",
      evidence: {
        signals: [],
        baseline: {
          entity: "purchase_request",
          metric: "rejection_rate",
          value: 0.42,
          calculatedAt: baselineDate,
        },
        context: {},
      },
    });
    const localServer = new McpServer({ name: "t2", version: "1.0.0" });
    registerInsightTools(localServer, createMockEngine([insight]));

    const result = await getTools(localServer).list_insights?.handler({}, {});
    const parsed = parseToolResult(result) as {
      insights: Array<{ evidence: { baseline?: { calculatedAt: string } } }>;
    };
    expect(parsed.insights[0]?.evidence.baseline?.calculatedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  test("list_insights honors checkToolPolicy when blocked", async () => {
    const localServer = new McpServer({ name: "t3", version: "1.0.0" });
    registerInsightTools(localServer, createMockEngine(INSIGHT_FIXTURES), {
      checkToolPolicy: () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ error: "denied" }) }],
        isError: true,
      }),
    });

    const result = await getTools(localServer).list_insights?.handler({}, {});
    expect(result.isError).toBe(true);
    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.error).toBe("denied");
  });

  test("list_insights clamps limit to MAX_LIMIT", async () => {
    const tools = getTools(server);
    const result = await tools.list_insights?.handler({ limit: 999 }, {});

    const parsed = parseToolResult(result) as { total: number; returned: number };
    // Only 5 insights exist; clamping doesn't manufacture more.
    expect(parsed.total).toBe(5);
    expect(parsed.returned).toBe(5);
  });
});
