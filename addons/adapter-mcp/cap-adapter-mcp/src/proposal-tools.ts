/**
 * Proposal tools for MCP runtime
 *
 * These tools allow AI agents to create, query, and list proposals
 * via the MCP transport. Proposals always start in "draft" status —
 * AI never auto-approves structural changes (Spec 60, Section 4.1).
 */

import type { Actor } from "@linchkit/core";
import type { ProposalEngine } from "@linchkit/core/server";
import type {
  ChangeType,
  ProposalAuthor,
  ProposalChangeOperation,
  ProposalChangeTarget,
  ProposalStatus,
} from "@linchkit/core/types";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toMcpShape } from "./zod-compat";

/** Error result returned when a tool is blocked by policy */
interface ToolBlockedResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

export interface ProposalToolsOptions {
  /** Session actor getter — called at invocation time to reflect auth changes. */
  getSessionActor?: () => Actor | undefined;
  /**
   * Tool policy checker. Returns an error result if the tool is not allowed,
   * or undefined if the tool is permitted.
   */
  checkToolPolicy?: (toolName: string, category: string) => ToolBlockedResult | undefined;
}

/**
 * Register proposal management tools on the MCP server.
 *
 * Tools registered:
 * - create_proposal: Create a new proposal in draft status
 * - get_proposal_status: Get proposal details by ID
 * - list_proposals: List proposals with optional filters
 */
export function registerProposalTools(
  server: McpServer,
  proposalEngine: ProposalEngine,
  options?: ProposalToolsOptions,
): void {
  // ── create_proposal ───────────────────────────────────
  const createProposalShape = {
    title: z.string().describe("Short title for the proposal"),
    description: z.string().describe("Detailed description of the proposed changes"),
    capability: z.string().describe("Target capability name"),
    changeType: z
      .enum(["patch", "minor", "major"])
      .describe("Severity of the change: patch (safe), minor (additive), major (breaking)"),
    changes: z
      .array(
        z.object({
          target: z
            .enum(["entity", "action", "rule", "view", "state", "event", "flow", "overlay"])
            .describe("Type of definition being changed"),
          operation: z
            .enum(["create", "update", "delete"])
            .describe("What operation is being performed"),
          name: z.string().describe("Name of the definition being changed"),
          definition: z
            .record(z.string(), z.unknown())
            .describe("The definition object (for create/update operations)")
            .optional(),
          diff: z.string().describe("Human-readable diff description").optional(),
        }),
      )
      .describe("List of changes in this proposal"),
  };

  server.tool(
    "create_proposal",
    "Create a structural change proposal (new field, new rule, etc.). " +
      "Proposals always start in draft status — AI never auto-approves. " +
      "Human approval is required before any structural change is applied.",
    toMcpShape(createProposalShape),
    async (args: {
      title: string;
      description: string;
      capability: string;
      changeType: ChangeType;
      changes: Array<{
        target: ProposalChangeTarget;
        operation: ProposalChangeOperation;
        name: string;
        definition?: Record<string, unknown>;
        diff?: string;
      }>;
    }) => {
      // Defense-in-depth: verify tool is allowed for current session
      const blocked = options?.checkToolPolicy?.("create_proposal", "proposals");
      if (blocked) return blocked;

      try {
        // Derive author from session actor if available, otherwise use default
        const actor = options?.getSessionActor?.();
        const author: ProposalAuthor = actor
          ? { type: actor.type as "human" | "ai", id: actor.id, name: actor.name ?? actor.id }
          : { type: "ai", id: "mcp-agent", name: "MCP AI Agent" };

        const proposal = proposalEngine.createProposal({
          title: args.title,
          description: args.description,
          author,
          capability: args.capability,
          changeType: args.changeType,
          changes: args.changes.map((c) => ({
            target: c.target,
            operation: c.operation,
            name: c.name,
            // Pass definition as ChangeDefinition if provided (cast — MCP input is untyped JSON)
            definition: c.definition as import("@linchkit/core/types").ChangeDefinition | undefined,
            diff: c.diff,
          })),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: proposal.id,
                  title: proposal.title,
                  status: proposal.status,
                  capability: proposal.capability,
                  changeType: proposal.changeType,
                  changes: proposal.changes,
                  impact: proposal.impact,
                  createdAt: proposal.createdAt.toISOString(),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Operation failed",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── get_proposal_status ───────────────────────────────
  const getProposalStatusShape = {
    proposalId: z.string().describe("Proposal ID to look up"),
  };

  server.tool(
    "get_proposal_status",
    "Get the current status and full details of a proposal by ID",
    toMcpShape(getProposalStatusShape),
    async (args: { proposalId: string }) => {
      // Defense-in-depth: verify tool is allowed for current session
      const blocked2 = options?.checkToolPolicy?.("get_proposal_status", "proposals");
      if (blocked2) return blocked2;

      try {
        const proposal = proposalEngine.getProposal(args.proposalId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: proposal.id,
                  title: proposal.title,
                  description: proposal.description,
                  status: proposal.status,
                  capability: proposal.capability,
                  changeType: proposal.changeType,
                  changes: proposal.changes,
                  impact: proposal.impact,
                  validationResult: proposal.validationResult,
                  createdAt: proposal.createdAt.toISOString(),
                  updatedAt: proposal.updatedAt.toISOString(),
                  approvedBy: proposal.approvedBy,
                  approvedAt: proposal.approvedAt?.toISOString(),
                  rejectionReason: proposal.rejectionReason,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Operation failed",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── list_proposals ────────────────────────────────────
  const listProposalsShape = {
    status: z
      .enum(["draft", "validating", "validated", "approved", "rejected", "committed", "deployed"])
      .describe("Filter by proposal status")
      .optional(),
    capability: z.string().describe("Filter by capability name").optional(),
  };

  server.tool(
    "list_proposals",
    "List proposals, optionally filtered by status and/or capability",
    toMcpShape(listProposalsShape),
    async (args: { status?: ProposalStatus; capability?: string }) => {
      // Defense-in-depth: verify tool is allowed for current session
      const blocked3 = options?.checkToolPolicy?.("list_proposals", "proposals");
      if (blocked3) return blocked3;

      try {
        const proposals = proposalEngine.listProposals({
          status: args.status,
          capability: args.capability,
        });

        const result = proposals.map((p) => ({
          id: p.id,
          title: p.title,
          status: p.status,
          capability: p.capability,
          changeType: p.changeType,
          changesCount: p.changes.length,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "Operation failed",
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
