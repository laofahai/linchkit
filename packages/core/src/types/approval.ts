/**
 * Approval type definitions
 *
 * Defines the ApprovalRequest model and related types.
 * When a Rule returns `require_approval`, an ApprovalRequest is created
 * and the action execution is suspended until approved/rejected.
 *
 * See spec 35_approval_mechanism.md for full details.
 */

import type { Actor } from "./action";

// ── Approval status ────────────────────────────────────

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

// ── Timeout policy ─────────────────────────────────────

export type ApprovalTimeoutPolicy = "reject" | "escalate" | "none";

// ── Assignee ───────────────────────────────────────────

export interface ApprovalAssignee {
  /** How the assignee is determined: role, group, or specific user */
  type: "role" | "group" | "user";
  /** The role name, group name, or user id */
  value: string;
}

// ── ApprovalRequest ────────────────────────────────────

export interface ApprovalRequest {
  id: string;

  /** The action that was suspended */
  action: string;
  /** The entity the action targets */
  entity?: string;
  /** The record id the action targets (if applicable) */
  recordId?: string;
  /** The capability that owns the action */
  capability?: string;
  /** Original action input (serialized) */
  input: Record<string, unknown>;

  /** Approval level (e.g. "director", "manager") */
  level: string;
  /** Human-readable reason for requiring approval */
  reason: string;
  /** Names of rules that triggered this approval */
  triggerRules: string[];

  /** The actor who initiated the action */
  requestedBy: Actor;
  /** Who can approve (role, group, or specific user) */
  assignee: ApprovalAssignee;

  /** Current approval status */
  status: ApprovalStatus;

  /** Who made the approval decision */
  decidedBy?: Actor;
  /** When the decision was made */
  decidedAt?: Date;
  /** Note from the approver (required on rejection) */
  decisionNote?: string;

  /** When the request expires (null = no expiration) */
  expiresAt?: Date;
  /** What to do on timeout */
  timeoutPolicy: ApprovalTimeoutPolicy;

  /** Execution ID of the original suspended execution */
  originalExecutionId: string;
  /** Execution ID of the re-execution after approval */
  executionId?: string;
  /** Error from re-execution after approval (if failed) */
  executionError?: string;

  /** Tenant context */
  tenantId?: string;

  /** Original ExecutionMeta captured at suspend, replayed on approve(). */
  meta?: Record<string, unknown>;

  /**
   * Adapter-injected system meta keys captured at suspend (Spec 65 §3.3).
   *
   * Holds the trusted `_`-prefixed keys an adapter set on the original
   * attempt (e.g. MCP's `_mcp_client_id`) MINUS any framework-reserved keys
   * (`_channel`, `_execution_id`, `_depth`, `_source_action`) — those belong
   * to the suspended attempt and are re-stamped by ActionEngine on replay.
   *
   * On approve(), this payload is passed through the trusted `systemMeta`
   * channel so attribution flows back to handlers / rules / logs on the
   * approved rerun (#230).
   */
  actorSystemMeta?: Record<string, unknown>;

  createdAt: Date;
  updatedAt: Date;
}

// ── ApprovalRequest query options ──────────────────────

export interface ApprovalQuery {
  status?: ApprovalStatus;
  action?: string;
  entity?: string;
  requestedById?: string;
  assigneeType?: ApprovalAssignee["type"];
  assigneeValue?: string;
  tenantId?: string;
}

// ── ApprovalStore interface ────────────────────────────

export interface ApprovalStore {
  /** Create a new approval request */
  create(request: ApprovalRequest): void | Promise<void>;
  /** Get a request by ID */
  getById(id: string): ApprovalRequest | undefined | Promise<ApprovalRequest | undefined>;
  /** Update a request */
  update(
    id: string,
    data: Partial<ApprovalRequest>,
  ): ApprovalRequest | undefined | Promise<ApprovalRequest | undefined>;
  /** Query requests by filters */
  query(options?: ApprovalQuery): ApprovalRequest[] | Promise<ApprovalRequest[]>;
  /** Get all pending requests that have expired */
  getExpired(): ApprovalRequest[] | Promise<ApprovalRequest[]>;
}

// ── Approval action result ─────────────────────────────

export interface ApprovalPendingResult {
  status: "pending_approval";
  approvalId: string;
  message: string;
  level: string;
}

// ── Approval decision input ────────────────────────────

export interface ApproveInput {
  approvalId: string;
  note?: string;
}

export interface RejectInput {
  approvalId: string;
  note: string;
}

export interface CancelInput {
  approvalId: string;
}
