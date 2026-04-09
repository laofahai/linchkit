/**
 * Execution log tools for MCP runtime
 *
 * These tools allow AI agents to query action execution history
 * for auditing, debugging, and observing system behavior (Spec 60, Section 4.1).
 */

import type { ExecutionLogger, ExecutionStatus } from "@linchkit/core/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpShape } from "./zod-compat";

/**
 * Register execution log query tools on the MCP server.
 *
 * Tools registered:
 * - get_execution_log: Get a single execution log entry by ID
 * - get_recent_executions: List recent executions with optional filters
 */
export function registerExecutionLogTools(
  server: McpServer,
  executionLogger: ExecutionLogger,
): void {
  // ── get_execution_log ─────────────────────────────────
  const getExecutionLogShape = {
    executionId: z.string().describe("Execution log entry ID"),
  };

  server.tool(
    "get_execution_log",
    "Retrieve the full execution log for an action execution by its ID, " +
      "including input, output, status, rules evaluated, and state transitions",
    toMcpShape(getExecutionLogShape),
    async (args: { executionId: string }) => {
      try {
        const entry = await executionLogger.getById(args.executionId);

        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `Execution log entry "${args.executionId}" not found`,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(serializeLogEntry(entry), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── get_recent_executions ─────────────────────────────
  const getRecentExecutionsShape = {
    entity: z.string().describe("Filter by entity name").optional(),
    action: z.string().describe("Filter by action name").optional(),
    status: z
      .enum(["succeeded", "failed", "blocked", "pending_approval"])
      .describe("Filter by execution status")
      .optional(),
    limit: z
      .number()
      .describe("Maximum number of entries to return (default 20, max 100)")
      .optional(),
  };

  server.tool(
    "get_recent_executions",
    "List recent action executions, optionally filtered by entity, action name, or status. " +
      "Returns entries sorted by most recent first.",
    toMcpShape(getRecentExecutionsShape),
    async (args: {
      entity?: string;
      action?: string;
      status?: ExecutionStatus;
      limit?: number;
    }) => {
      try {
        const pageSize = Math.min(Math.max(args.limit ?? 20, 1), 100);

        const result = await executionLogger.findMany({
          entity: args.entity,
          action: args.action,
          status: args.status,
          page: 1,
          pageSize,
          sortField: "startedAt",
          sortOrder: "desc",
        });

        const entries = result.items.map(serializeLogEntry);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ total: result.total, entries }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
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

/** Serialize a log entry to a JSON-safe format (dates to ISO strings) */
function serializeLogEntry(
  entry: import("@linchkit/core/types").ExecutionLogEntry,
): Record<string, unknown> {
  return {
    id: entry.id,
    action: entry.action,
    entity: entry.entity,
    capability: entry.capability,
    recordId: entry.recordId,
    actor: entry.actor,
    input: entry.input,
    output: entry.output,
    status: entry.status,
    error: entry.error,
    rulesEvaluated: entry.rulesEvaluated,
    stateTransition: entry.stateTransition,
    channel: entry.channel,
    duration: entry.duration,
    startedAt: entry.startedAt.toISOString(),
    completedAt: entry.completedAt?.toISOString(),
  };
}
