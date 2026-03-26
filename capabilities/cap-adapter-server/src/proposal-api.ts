/**
 * Proposal / Evolution / AI Insights REST API endpoints
 *
 * Mounts onto the Elysia app instance. Uses ProposalEngine from core
 * for proposal lifecycle management, and generates demo insights
 * when AI service is not configured.
 */

import type { ProposalDefinition } from "@linchkit/core";
import { createProposalEngine, PatternDetector } from "@linchkit/core/server";
import type { PatternInsight } from "@linchkit/core/server";
import type { ExecutionLogger } from "@linchkit/core/types";
import type { Elysia } from "elysia";

// ── Types ─────────────────────────────────────────────────

/** AI Insight — a pattern detected by the system that may lead to a proposal */
export interface AIInsight {
  id: string;
  description: string;
  confidence: number;
  category: "rule_suggestion" | "default_value" | "validation" | "optimization" | "anomaly";
  suggestedAction: string;
  relatedSchema?: string;
  relatedField?: string;
  detectedAt: string;
  dataPoints?: number;
}

/** Evolution entry — a record of an approved and applied change */
export interface EvolutionEntry {
  id: string;
  proposalId: string;
  title: string;
  description: string;
  changeType: "patch" | "minor" | "major";
  capability: string;
  authorType: "human" | "ai";
  authorName: string;
  approvedBy: string;
  appliedAt: string;
  reasoning: string;
  changes: Array<{
    target: string;
    operation: string;
    name: string;
    diff?: string;
  }>;
  version?: string;
  canRevert: boolean;
}

// ── Singleton ProposalEngine (in-memory for M2) ──────────

const proposalEngine = createProposalEngine();
const patternDetector = new PatternDetector();

// ── Cached insights from PatternDetector ─────────────────

let cachedInsights: AIInsight[] = [];
let insightsLastScanned = 0;
/** Minimum interval between insight scans (5 minutes) */
const INSIGHT_SCAN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Map PatternInsight from core to the AIInsight REST type.
 */
function mapPatternInsightToAIInsight(pi: PatternInsight): AIInsight {
  const categoryMap: Record<string, AIInsight["category"]> = {
    repetitive_action: "rule_suggestion",
    default_value: "default_value",
    validation_pattern: "validation",
    state_flow: "optimization",
    timing: "optimization",
  };
  return {
    id: pi.id,
    description: pi.description,
    confidence: pi.confidence,
    category: categoryMap[pi.type] ?? "optimization",
    suggestedAction: pi.suggestedAction.description,
    relatedSchema: pi.schema,
    detectedAt: new Date().toISOString(),
    dataPoints: pi.evidence.count,
  };
}

/**
 * Scan execution logs with PatternDetector and create proposals for detected patterns.
 * Results are cached to avoid repeated scans.
 */
async function scanInsights(executionLogger: ExecutionLogger): Promise<AIInsight[]> {
  const now = Date.now();
  if (now - insightsLastScanned < INSIGHT_SCAN_INTERVAL_MS && cachedInsights.length > 0) {
    return cachedInsights;
  }

  try {
    const patterns = await patternDetector.analyze(executionLogger);
    cachedInsights = patterns.map(mapPatternInsightToAIInsight);
    insightsLastScanned = now;

    // Auto-create proposals for high-confidence patterns not already proposed
    for (const pattern of patterns) {
      if (pattern.confidence >= 0.8) {
        const existing = proposalEngine.listProposals({});
        const alreadyProposed = existing.some(
          (p) => p.title === pattern.suggestedAction.description,
        );
        if (!alreadyProposed) {
          proposalEngine.createProposal({
            title: pattern.suggestedAction.description,
            description: pattern.description,
            author: { type: "ai", id: "pattern-detector", name: "Pattern Detector" },
            capability: pattern.schema,
            changeType: "minor",
            changes: [
              {
                target: "rule",
                operation: "create",
                name: pattern.id,
                diff: pattern.suggestedAction.description,
              },
            ],
          });
        }
      }
    }
  } catch {
    // If analysis fails (e.g. no logs), return empty
    cachedInsights = [];
    insightsLastScanned = now;
  }

  return cachedInsights;
}

// ── Mount endpoints onto Elysia app ──────────────────────

/**
 * Register proposal/evolution/insights REST endpoints on the given Elysia app.
 * Call this in createServer() after the main app is created.
 *
 * @param app Elysia app instance
 * @param executionLogger Optional execution logger for real PatternDetector analysis
 */
// biome-ignore lint/suspicious/noExplicitAny: Elysia plugin typing
export function mountProposalAPI(app: any, executionLogger?: ExecutionLogger): void {
  // Run initial pattern scan in background if execution logger is available
  if (executionLogger) {
    scanInsights(executionLogger).catch(() => {
      // Silently ignore startup scan errors
    });
  }

  // ── Proposals ──────────────────────────────────────────

  app.get("/api/proposals", ({ query }: { query: Record<string, string | undefined> }) => {
    const filter: { status?: string; capability?: string } = {};
    if (query.status) filter.status = query.status;
    if (query.capability) filter.capability = query.capability;

    const proposals = proposalEngine.listProposals(filter);
    // Sort by creation date descending (newest first)
    proposals.sort((a: ProposalDefinition, b: ProposalDefinition) =>
      b.createdAt.getTime() - a.createdAt.getTime(),
    );

    // Count pending proposals for badge
    const pendingCount = proposalEngine.listProposals({ status: "draft" }).length
      + proposalEngine.listProposals({ status: "validated" }).length;

    return {
      success: true,
      data: {
        items: proposals.map(serializeProposal),
        total: proposals.length,
        pendingCount,
      },
    };
  });

  app.get("/api/proposals/:id", ({ params, set }: { params: { id: string }; set: { status: number } }) => {
    try {
      const proposal = proposalEngine.getProposal(params.id);
      return { success: true, data: serializeProposal(proposal) };
    } catch {
      set.status = 404;
      return { success: false, error: { message: `Proposal "${params.id}" not found.` } };
    }
  });

  app.post("/api/proposals/:id/approve", ({ params, set }: { params: { id: string }; set: { status: number } }) => {
    try {
      const proposal = proposalEngine.getProposal(params.id);

      // If draft, auto-submit first
      if (proposal.status === "draft") {
        proposalEngine.submitProposal({ proposalId: params.id });
      }

      // Re-fetch to check validation result
      const refreshed = proposalEngine.getProposal(params.id);
      if (refreshed.status !== "validated") {
        set.status = 422;
        return {
          success: false,
          error: { message: "Proposal validation failed. Cannot approve." },
          data: refreshed.validationResult,
        };
      }

      const approved = proposalEngine.approveProposal({
        proposalId: params.id,
        approvedBy: { type: "human", id: "admin" },
      });
      return { success: true, data: serializeProposal(approved) };
    } catch (err) {
      set.status = 422;
      return { success: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  });

  app.post("/api/proposals/:id/reject", ({ params, body, set }: { params: { id: string }; body: unknown; set: { status: number } }) => {
    try {
      const proposal = proposalEngine.getProposal(params.id);

      // If draft, auto-submit first
      if (proposal.status === "draft") {
        proposalEngine.submitProposal({ proposalId: params.id });
      }

      const refreshed = proposalEngine.getProposal(params.id);
      if (refreshed.status !== "validated") {
        set.status = 422;
        return { success: false, error: { message: "Proposal validation failed. Cannot reject." } };
      }

      const reason = (body as Record<string, string>)?.reason ?? "Rejected by user";
      const rejected = proposalEngine.rejectProposal({ proposalId: params.id, reason });
      return { success: true, data: serializeProposal(rejected) };
    } catch (err) {
      set.status = 422;
      return { success: false, error: { message: err instanceof Error ? err.message : String(err) } };
    }
  });

  // ── AI Insights ────────────────────────────────────────

  app.get("/api/ai/insights", async () => {
    if (!executionLogger) {
      return { success: true, data: [] };
    }
    const insights = await scanInsights(executionLogger);
    return { success: true, data: insights };
  });

  // ── Evolution History ──────────────────────────────────

  app.get("/api/evolution/history", () => {
    // Evolution history is derived from committed/deployed proposals
    const allProposals = proposalEngine.listProposals({});
    const committed = allProposals.filter(
      (p) => p.status === "committed" || p.status === "deployed",
    );
    const history: EvolutionEntry[] = committed.map((p) => ({
      id: `evo-${p.id}`,
      proposalId: p.id,
      title: p.title,
      description: p.description,
      changeType: p.changeType,
      capability: p.capability,
      authorType: p.author.type,
      authorName: p.author.name ?? p.author.id,
      approvedBy: p.approvedBy ? `${p.approvedBy.type}:${p.approvedBy.id}` : "unknown",
      appliedAt: (p.committedAt ?? p.approvedAt ?? p.updatedAt).toISOString(),
      reasoning: p.description,
      changes: p.changes.map((c) => ({
        target: c.target,
        operation: c.operation,
        name: c.name,
        diff: c.diff,
      })),
      canRevert: false,
    }));
    return { success: true, data: history };
  });

  // ── Pending count (for sidebar badge) ──────────────────

  app.get("/api/proposals/pending-count", () => {
    const pendingCount = proposalEngine.listProposals({ status: "draft" }).length
      + proposalEngine.listProposals({ status: "validated" }).length;
    return { success: true, data: { count: pendingCount } };
  });
}

// ── Serialization helper ─────────────────────────────────

function serializeProposal(p: ProposalDefinition): Record<string, unknown> {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    author: p.author,
    capability: p.capability,
    changeType: p.changeType,
    changes: p.changes,
    impact: p.impact,
    status: p.status,
    validationResult: p.validationResult,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    validatedAt: p.validatedAt?.toISOString(),
    approvedAt: p.approvedAt?.toISOString(),
    committedAt: p.committedAt?.toISOString(),
    deployedAt: p.deployedAt?.toISOString(),
    approvedBy: p.approvedBy,
    rejectionReason: p.rejectionReason,
  };
}
