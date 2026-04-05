/**
 * AI Security MCP Tools
 *
 * Exposes AI security primitives (boundary checks, audit logs, prompt sanitization)
 * as MCP tools so AI agents can audit their own operations and check boundaries
 * before acting.
 *
 * These tools are only registered when AIBoundary and/or AIAuditLogger are
 * available in the TransportContext.
 */

import type { AIAuditLogger, AIBoundary } from "@linchkit/core/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpShape } from "./zod-compat";

export interface AISecurityToolsOptions {
  server: McpServer;
  aiBoundary?: AIBoundary;
  aiAuditLogger?: AIAuditLogger;
}

/** Register AI security tools on the MCP server */
export function registerAISecurityTools(options: AISecurityToolsOptions): void {
  const { server, aiBoundary, aiAuditLogger } = options;

  // Only register if at least one AI security component is available
  if (!aiBoundary && !aiAuditLogger) return;

  // ── check_ai_boundary ─────────────────────────────────────
  if (aiBoundary) {
    const checkBoundaryShape = {
      actionName: z.string().describe("Action name to check").optional(),
      tenantId: z.string().describe("Tenant ID for policy resolution").optional(),
      isDataModification: z
        .boolean()
        .describe("Whether the operation would modify data")
        .optional(),
      estimatedTokens: z.number().describe("Estimated token count for the operation").optional(),
    };

    server.tool(
      "check_ai_boundary",
      "Pre-flight check whether an AI operation would be allowed under the current boundary policy. Returns allowed status, reason, and any warnings.",
      toMcpShape(checkBoundaryShape),
      async (args: {
        actionName?: string;
        tenantId?: string;
        isDataModification?: boolean;
        estimatedTokens?: number;
      }) => {
        const result = aiBoundary.check({
          source: "mcp",
          actionName: args.actionName,
          tenantId: args.tenantId,
          isDataModification: args.isDataModification ?? false,
          estimatedTokens: args.estimatedTokens,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  allowed: result.allowed,
                  reason: result.reason ?? null,
                  warnings: result.warnings ?? [],
                  policyName: result.policyName ?? null,
                  violation: result.violation ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // ── get_ai_usage ──────────────────────────────────────────
    const getUsageShape = {
      tenantId: z.string().describe("Tenant ID to filter usage records").optional(),
    };

    server.tool(
      "get_ai_usage",
      "Get AI usage statistics including budget status and recent usage count for a tenant or globally.",
      toMcpShape(getUsageShape),
      async (args: { tenantId?: string }) => {
        const budget = aiBoundary.getBudget(args.tenantId);
        const recentRecords = aiBoundary.getUsageRecords({
          tenantId: args.tenantId,
          limit: 100,
        });

        const result = {
          budget: {
            tenantId: budget.tenantId ?? "global",
            costToday: budget.costToday,
            costThisHour: budget.costThisHour,
            tokensToday: budget.tokensToday,
            requestsToday: budget.requestsToday,
            requestsThisHour: budget.requestsThisHour,
            requestsThisMinute: budget.requestsThisMinute,
          },
          recentUsageCount: recentRecords.length,
          policy: {
            name: aiBoundary.getEffectivePolicy(args.tenantId).name,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      },
    );
  }

  // ── sanitize_prompt ─────────────────────────────────────────
  // Always register — sanitizePrompt is a pure function, no runtime dependency needed
  const sanitizePromptShape = {
    text: z.string().describe("The prompt text to sanitize"),
    enablePII: z.boolean().describe("Whether to run PII redaction (default: true)").optional(),
    enableInjectionDetection: z
      .boolean()
      .describe("Whether to run injection detection (default: true)")
      .optional(),
  };

  server.tool(
    "sanitize_prompt",
    "Sanitize a prompt before sending to an AI model. Detects prompt injection attempts and redacts PII (email, phone, SSN, credit card, etc.).",
    toMcpShape(sanitizePromptShape),
    async (args: { text: string; enablePII?: boolean; enableInjectionDetection?: boolean }) => {
      // Lazy import to avoid loading at registration time
      const { sanitizePrompt } = await import("@linchkit/core/server");

      const result = sanitizePrompt(args.text, {
        enablePII: args.enablePII,
        enableInjectionDetection: args.enableInjectionDetection,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                sanitized: result.sanitized,
                blocked: result.blocked,
                blockReason: result.blockReason ?? null,
                injection: {
                  detected: result.injection.detected,
                  score: result.injection.score,
                  matchedPatterns: result.injection.matchedPatterns,
                  action: result.injection.action,
                },
                pii: result.pii
                  ? {
                      piiTypesFound: result.pii.piiTypesFound,
                      redactionCount: result.pii.redactionCount,
                    }
                  : null,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── ai_audit_summary ────────────────────────────────────────
  if (aiAuditLogger) {
    const auditSummaryShape = {
      tenantId: z.string().describe("Tenant ID to filter audit entries").optional(),
      limit: z.number().describe("Maximum number of entries to include (default: 50)").optional(),
    };

    server.tool(
      "ai_audit_summary",
      "Get a summary of AI audit entries including totals by event type and risk level. Useful for compliance monitoring and reviewing AI agent behavior.",
      toMcpShape(auditSummaryShape),
      async (args: { tenantId?: string; limit?: number }) => {
        const report = aiAuditLogger.exportReport({
          tenantId: args.tenantId,
          limit: args.limit ?? 50,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  generatedAt: report.generatedAt,
                  totalEntries: report.totalEntries,
                  summary: report.summary,
                  // Include only recent entries (not the full audit trail)
                  // biome-ignore lint/suspicious/noExplicitAny: audit entry shape varies
                  recentEntries: report.entries.slice(0, 10).map((e: any) => ({
                    id: e.id,
                    timestamp: e.timestamp,
                    eventType: e.eventType,
                    riskLevel: e.riskLevel,
                    actionName: e.actionName ?? null,
                    tenantId: e.tenantId ?? null,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }
}
