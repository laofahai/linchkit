/**
 * Proposal / Evolution / AI Insights REST API endpoints
 *
 * Mounts onto the Elysia app instance. Uses ProposalEngine from core
 * for proposal lifecycle management, and generates demo insights
 * when AI service is not configured.
 */

import type { ProposalDefinition } from "@linchkit/core";
import { createProposalEngine } from "@linchkit/core/server";
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

// ── Demo data seeding ────────────────────────────────────

let seeded = false;

function seedDemoData(): void {
  if (seeded) return;
  seeded = true;

  // Create some demo proposals for showcase
  const demoProposals = [
    {
      title: "Add auto-approve rule for small purchases",
      description: "AI detected that 87% of purchase requests under $1,000 are approved within 5 minutes. Suggests adding an auto-approve rule for amounts under $1,000 to reduce manual work.",
      author: { type: "ai" as const, id: "ai-evolver", name: "AI Evolver" },
      capability: "purchase_management",
      changeType: "minor" as const,
      changes: [
        {
          target: "rule" as const,
          operation: "create" as const,
          name: "auto_approve_small_purchases",
          diff: 'Add rule: if amount < 1000, auto-approve (skip manual approval step)',
        },
      ],
    },
    {
      title: "Set default department to General Administration",
      description: "AI observed that 73% of purchase requests set department to 'General Administration'. Suggests setting this as the default value.",
      author: { type: "ai" as const, id: "ai-evolver", name: "AI Evolver" },
      capability: "purchase_management",
      changeType: "patch" as const,
      changes: [
        {
          target: "schema" as const,
          operation: "update" as const,
          name: "purchase_request",
          diff: 'Set default value for "department" field to "General Administration"',
        },
      ],
    },
    {
      title: "Add email validation rule for requester field",
      description: "AI detected that 95% of requester values follow the pattern user@company.com. Suggests adding a validation rule to enforce this format.",
      author: { type: "ai" as const, id: "ai-evolver", name: "AI Evolver" },
      capability: "purchase_management",
      changeType: "minor" as const,
      changes: [
        {
          target: "rule" as const,
          operation: "create" as const,
          name: "validate_requester_email",
          diff: 'Add validation rule: requester must match pattern *@company.com',
        },
      ],
    },
  ];

  for (const demo of demoProposals) {
    proposalEngine.createProposal(demo);
  }
}

// ── Demo insights (static for now, AI-generated in future) ──

function generateDemoInsights(): AIInsight[] {
  return [
    {
      id: "insight-1",
      description: "3 purchase requests over $10,000 were manually approved this week — auto-approve rule suggested",
      confidence: 0.87,
      category: "rule_suggestion",
      suggestedAction: "Create auto-approve rule for high-value purchases with manager pre-approval",
      relatedSchema: "purchase_request",
      relatedField: "amount",
      detectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      dataPoints: 47,
    },
    {
      id: "insight-2",
      description: 'Department field is always set to "General Administration" — consider setting a default',
      confidence: 0.73,
      category: "default_value",
      suggestedAction: "Set default value for department field",
      relatedSchema: "purchase_request",
      relatedField: "department",
      detectedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      dataPoints: 156,
    },
    {
      id: "insight-3",
      description: "Requester email follows pattern user@company.com — add validation rule?",
      confidence: 0.95,
      category: "validation",
      suggestedAction: "Add email format validation rule",
      relatedSchema: "purchase_request",
      relatedField: "requester",
      detectedAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      dataPoints: 89,
    },
    {
      id: "insight-4",
      description: "Average approval time increased 40% this month — potential bottleneck in approval flow",
      confidence: 0.62,
      category: "optimization",
      suggestedAction: "Review approval workflow and consider parallel approvers",
      relatedSchema: "purchase_request",
      detectedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      dataPoints: 234,
    },
    {
      id: "insight-5",
      description: "Unusual spike in rejected requests from Engineering department — investigate pattern",
      confidence: 0.78,
      category: "anomaly",
      suggestedAction: "Review rejection reasons for Engineering department requests",
      relatedSchema: "purchase_request",
      relatedField: "department",
      detectedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      dataPoints: 12,
    },
  ];
}

// ── Demo evolution history ───────────────────────────────

function generateDemoEvolution(): EvolutionEntry[] {
  const now = Date.now();
  return [
    {
      id: "evo-1",
      proposalId: "demo-p1",
      title: "Added priority field to purchase requests",
      description: "AI suggested adding a priority field based on observed urgency patterns in purchase request descriptions.",
      changeType: "minor",
      capability: "purchase_management",
      authorType: "ai",
      authorName: "AI Evolver",
      approvedBy: "admin",
      appliedAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      reasoning: "Analysis of 200+ purchase requests showed 35% contained urgency keywords. A dedicated priority field improves workflow routing.",
      changes: [
        { target: "schema", operation: "update", name: "purchase_request", diff: 'Added field: priority (enum: low, medium, high, urgent)' },
      ],
      version: "1.1.0",
      canRevert: true,
    },
    {
      id: "evo-2",
      proposalId: "demo-p2",
      title: "Optimized approval threshold from $5,000 to $10,000",
      description: "Based on 6-month approval data analysis, raised the auto-approve threshold to reduce unnecessary manual reviews.",
      changeType: "patch",
      capability: "purchase_management",
      authorType: "ai",
      authorName: "AI Evolver",
      approvedBy: "finance_manager",
      appliedAt: new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
      reasoning: "Historical data shows 99.2% of requests between $5,000-$10,000 were approved. Raising the threshold saves ~15 hours/week of review time.",
      changes: [
        { target: "rule", operation: "update", name: "amount_approval_threshold", diff: 'Changed threshold: $5,000 -> $10,000' },
      ],
      version: "1.0.2",
      canRevert: true,
    },
    {
      id: "evo-3",
      proposalId: "demo-p3",
      title: "Added department budget validation rule",
      description: "New rule to check department monthly budget before allowing purchase request submission.",
      changeType: "minor",
      capability: "purchase_management",
      authorType: "human",
      authorName: "Developer",
      approvedBy: "admin",
      appliedAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
      reasoning: "Multiple departments exceeded their monthly budgets. This rule prevents over-spending by validating against budget allocation.",
      changes: [
        { target: "rule", operation: "create", name: "department_budget_check", diff: 'New rule: validate purchase amount against department monthly budget' },
        { target: "schema", operation: "update", name: "purchase_request", diff: 'Added computed field: department_budget_remaining' },
      ],
      version: "1.1.0",
      canRevert: false,
    },
  ];
}

// ── Mount endpoints onto Elysia app ──────────────────────

/**
 * Register proposal/evolution/insights REST endpoints on the given Elysia app.
 * Call this in createServer() after the main app is created.
 */
// biome-ignore lint/suspicious/noExplicitAny: Elysia plugin typing
export function mountProposalAPI(app: any): void {
  seedDemoData();

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

  app.get("/api/ai/insights", () => {
    const insights = generateDemoInsights();
    return { success: true, data: insights };
  });

  // ── Evolution History ──────────────────────────────────

  app.get("/api/evolution/history", () => {
    const history = generateDemoEvolution();
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
