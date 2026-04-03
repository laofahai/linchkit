/**
 * API client for Proposal / Evolution / AI Insights endpoints.
 */

// ── Auth header helper (reuse from api.ts pattern) ──────

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

// ── Types ─────────────────────────────────────────────────

export interface ProposalChange {
  target: string;
  operation: string;
  name: string;
  definition?: unknown;
  diff?: string;
}

export interface ProposalImpact {
  schemasAffected: string[];
  actionsAffected: string[];
  rulesAffected: string[];
  dependentsAffected: string[];
  migrationRequired: boolean;
}

export interface Proposal {
  id: string;
  title: string;
  description: string;
  author: { type: "human" | "ai"; id: string; name: string };
  capability: string;
  changeType: "patch" | "minor" | "major";
  changes: ProposalChange[];
  impact: ProposalImpact;
  status: string;
  validationResult?: {
    passed: boolean;
    phases: Array<{
      phase: number;
      status: string;
      errors: Array<{ code: string; message: string }>;
      warnings: Array<{ code: string; message: string }>;
      duration: number;
    }>;
    impactSummary: string;
  };
  createdAt: string;
  updatedAt: string;
  validatedAt?: string;
  approvedAt?: string;
  committedAt?: string;
  deployedAt?: string;
  approvedBy?: { type: string; id: string };
  rejectionReason?: string;
}

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

// ── API calls ─────────────────────────────────────────────

export async function fetchProposals(status?: string): Promise<{
  items: Proposal[];
  total: number;
  pendingCount: number;
}> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const url = `/api/proposals${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? { items: [], total: 0, pendingCount: 0 };
}

export async function fetchProposal(id: string): Promise<Proposal | null> {
  const res = await fetch(`/api/proposals/${id}`, { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? null;
}

export async function approveProposal(id: string): Promise<Proposal> {
  const res = await fetch(`/api/proposals/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Approval failed");
  return json.data;
}

export async function rejectProposal(id: string, reason: string): Promise<Proposal> {
  const res = await fetch(`/api/proposals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ reason }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Rejection failed");
  return json.data;
}

export async function fetchAIInsights(): Promise<AIInsight[]> {
  const res = await fetch("/api/ai/insights", { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? [];
}

export async function fetchEvolutionHistory(): Promise<EvolutionEntry[]> {
  const res = await fetch("/api/evolution/history", { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? [];
}

export async function fetchPendingCount(): Promise<number> {
  const res = await fetch("/api/proposals/pending-count", { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data?.count ?? 0;
}
