/**
 * API client for Approval workflow endpoints.
 *
 * Provides fetch wrappers for listing, counting, approving, and rejecting
 * approval requests from the ApprovalEngine REST API.
 */

// ── Auth header helper (reuse from api.ts pattern) ──────

import { getTenantHeaders } from "./tenant";

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  const tenantHeaders = getTenantHeaders();
  if (token) {
    return { Authorization: `Bearer ${token}`, ...tenantHeaders };
  }
  return { ...tenantHeaders };
}

// ── Types ─────────────────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface ApprovalAssignee {
  type: "role" | "group" | "user";
  value: string;
}

export interface ApprovalRequestItem {
  id: string;
  action: string;
  schema?: string;
  recordId?: string;
  capability?: string;
  input: Record<string, unknown>;
  level: string;
  reason: string;
  triggerRules: string[];
  requestedBy: { type: string; id: string; groups: string[] };
  assignee: ApprovalAssignee;
  status: ApprovalStatus;
  decidedBy?: { type: string; id: string };
  decidedAt?: string;
  decisionNote?: string;
  expiresAt?: string;
  timeoutPolicy: string;
  originalExecutionId: string;
  executionId?: string;
  executionError?: string;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalListResult {
  items: ApprovalRequestItem[];
  total: number;
}

// ── API calls ─────────────────────────────────────────────

/**
 * Fetch approval requests, defaulting to pending status.
 */
export async function fetchApprovals(status?: ApprovalStatus): Promise<ApprovalListResult> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const url = `/api/approvals${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, { headers: getAuthHeaders() });
  const json = await res.json();
  return json.data ?? { items: [], total: 0 };
}

/**
 * Fetch pending approval count for badge display.
 */
export async function fetchApprovalCount(): Promise<number> {
  try {
    const res = await fetch("/api/approvals/count", { headers: getAuthHeaders() });
    const json = await res.json();
    return json.data?.count ?? 0;
  } catch {
    // Server unreachable or endpoint not available — show zero pending approvals
    return 0;
  }
}

/**
 * Fetch a single approval request by ID.
 */
export async function fetchApproval(id: string): Promise<ApprovalRequestItem | null> {
  const res = await fetch(`/api/approvals/${id}`, { headers: getAuthHeaders() });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data ?? null;
}

/**
 * Approve an approval request.
 */
export async function approveRequest(id: string, note?: string): Promise<void> {
  const res = await fetch(`/api/approvals/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ note }),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? "Approval failed");
  }
}

/**
 * Reject an approval request.
 */
export async function rejectRequest(id: string, note: string): Promise<void> {
  const res = await fetch(`/api/approvals/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ note }),
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error?.message ?? "Rejection failed");
  }
}
