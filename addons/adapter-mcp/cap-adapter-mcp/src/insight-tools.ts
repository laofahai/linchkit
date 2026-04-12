/**
 * Insight tools for MCP runtime
 *
 * These tools allow AI agents to query promoted Insights from the
 * Spec 55 life-system InsightEngine. Insights are evidence-backed
 * observations (anomalies, friction, patterns, structural issues,
 * positive signals) — they are not suggestions and never auto-apply.
 */

import type { Insight, InsightEngine, InsightType } from "@linchkit/core/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpShape } from "./zod-compat";

/** Error result returned when a tool is blocked by policy */
interface ToolBlockedResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export interface InsightToolsOptions {
  /**
   * Tool policy checker. Returns an error result if the tool is not allowed,
   * or undefined if the tool is permitted.
   */
  checkToolPolicy?: (toolName: string, category: string) => ToolBlockedResult | undefined;
}

/** Default cap on returned insights when no limit is provided. */
const DEFAULT_LIMIT = 50;
/** Hard upper bound on returned insights. */
const MAX_LIMIT = 200;

/**
 * Register insight query tools on the MCP server.
 *
 * Tools registered:
 * - list_insights: List promoted insights with optional entity/type/limit filters
 */
export function registerInsightTools(
  server: McpServer,
  insightEngine: InsightEngine,
  options?: InsightToolsOptions,
): void {
  const checkToolPolicy = options?.checkToolPolicy;

  // ── list_insights ─────────────────────────────────────
  const listInsightsShape = {
    entity: z.string().describe("Filter insights by entity name").optional(),
    type: z
      .enum(["anomaly", "friction", "pattern", "structural", "positive"])
      .describe("Filter insights by type")
      .optional(),
    limit: z
      .number()
      .int()
      .describe(`Maximum number of insights to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`)
      .optional(),
  };

  server.tool(
    "list_insights",
    "List promoted insights from the evolution life-system, optionally filtered " +
      "by entity name and/or type. Insights are evidence-backed observations " +
      "produced by the InsightEngine — they are not suggestions and never auto-apply.",
    toMcpShape(listInsightsShape),
    async (args: { entity?: string; type?: InsightType; limit?: number }) => {
      // Defense-in-depth: verify tool is allowed for current session
      const blocked = checkToolPolicy?.("list_insights", "insight");
      if (blocked) return blocked;

      try {
        const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const all = insightEngine.getInsights();

        const filtered = all.filter((insight) => {
          if (args.entity !== undefined && insight.entity !== args.entity) return false;
          if (args.type !== undefined && insight.type !== args.type) return false;
          return true;
        });

        const sliced = filtered.slice(0, limit);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  total: filtered.length,
                  returned: sliced.length,
                  insights: sliced.map(serializeInsight),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (_err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Failed to list insights",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}

// ── Helpers ───────────────────────────────────────────────

/** Serialize an Insight to a JSON-safe format (dates to ISO strings). */
function serializeInsight(insight: Insight): Record<string, unknown> {
  return {
    id: insight.id,
    type: insight.type,
    causality: insight.causality,
    entity: insight.entity,
    summary: insight.summary,
    confidence: insight.confidence,
    impact: insight.impact,
    createdAt: insight.createdAt.toISOString(),
    evidence: {
      signalCount: insight.evidence.signals.length,
      baseline: insight.evidence.baseline
        ? {
            entity: insight.evidence.baseline.entity,
            metric: insight.evidence.baseline.metric,
            value: insight.evidence.baseline.value,
            calculatedAt: insight.evidence.baseline.calculatedAt.toISOString(),
          }
        : undefined,
      context: insight.evidence.context,
    },
  };
}
