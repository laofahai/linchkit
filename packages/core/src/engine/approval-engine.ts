/**
 * Approval Engine
 *
 * Manages the lifecycle of ApprovalRequests:
 * - Creating requests when rules return require_approval
 * - Processing approve/reject/cancel/expire decisions
 * - Re-executing the original action on approval
 *
 * See spec 35_approval_mechanism.md for full details.
 */

import type { EventBus } from "../event/event-bus";
import { consoleLogger } from "../observability/console-logger";
import type { ActionResult, Actor } from "../types/action";
import type {
  ApprovalAssignee,
  ApprovalPendingResult,
  ApprovalQuery,
  ApprovalRequest,
  ApprovalStore,
  ApprovalTimeoutPolicy,
  ApproveInput,
  CancelInput,
  RejectInput,
} from "../types/approval";
import type { EventRecord } from "../types/event";
import type { RequireApprovalEffect } from "../types/rule";
import type { ActionExecutor } from "./action-engine";
import type { CommandLayer } from "./command-layer";
import type { PermissionRegistry } from "./permission-engine";

// ── InMemoryApprovalStore ──────────────────────────────────

export class InMemoryApprovalStore implements ApprovalStore {
  private requests = new Map<string, ApprovalRequest>();

  create(request: ApprovalRequest): void {
    this.requests.set(request.id, structuredClone(request));
  }

  getById(id: string): ApprovalRequest | undefined {
    const request = this.requests.get(id);
    return request ? structuredClone(request) : undefined;
  }

  update(id: string, data: Partial<ApprovalRequest>): ApprovalRequest | undefined {
    const existing = this.requests.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data, updatedAt: new Date() };
    this.requests.set(id, updated);
    return structuredClone(updated);
  }

  query(options?: ApprovalQuery): ApprovalRequest[] {
    let results = Array.from(this.requests.values()).map((r) => structuredClone(r));

    if (options?.status) {
      results = results.filter((r) => r.status === options.status);
    }
    if (options?.action) {
      results = results.filter((r) => r.action === options.action);
    }
    if (options?.entity) {
      results = results.filter((r) => r.entity === options.entity);
    }
    if (options?.requestedById) {
      results = results.filter((r) => r.requestedBy.id === options.requestedById);
    }
    if (options?.assigneeType) {
      results = results.filter((r) => r.assignee.type === options.assigneeType);
    }
    if (options?.assigneeValue) {
      results = results.filter((r) => r.assignee.value === options.assigneeValue);
    }
    if (options?.tenantId) {
      results = results.filter((r) => r.tenantId === options.tenantId);
    }

    return results;
  }

  getExpired(): ApprovalRequest[] {
    const now = new Date();
    return Array.from(this.requests.values())
      .filter((r) => r.status === "pending" && r.expiresAt && r.expiresAt <= now)
      .map((r) => structuredClone(r));
  }

  /** Clear all entries (useful for testing) */
  clear(): void {
    this.requests.clear();
  }

  /** Get total count */
  get size(): number {
    return this.requests.size;
  }
}

// ── Helpers ────────────────────────────────────────────────

function createApprovalEvent(options: {
  type: string;
  request: ApprovalRequest;
  actor: Actor;
  executionId: string;
  extraPayload?: Record<string, unknown>;
}): EventRecord {
  const { type, request, actor, executionId, extraPayload } = options;
  return {
    id: crypto.randomUUID(),
    type,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: actor.type, id: actor.id },
    entity: request.entity,
    action: request.action,
    executionId,
    payload: {
      approvalId: request.id,
      level: request.level,
      status: request.status,
      ...extraPayload,
    },
  };
}

// ── ApprovalEngine ─────────────────────────────────────────

export interface ApprovalEngineOptions {
  store: ApprovalStore;
  eventBus?: EventBus;
  /** The action executor for re-execution on approval (fallback when commandLayer is not set) */
  executor?: ActionExecutor;
  /**
   * The CommandLayer for re-execution on approval.
   * When set, approval re-execution routes through the pipeline (skipping auth/exposure/permission).
   * When not set, falls back to direct executor.execute() with a deprecation warning.
   */
  commandLayer?: CommandLayer;
  /**
   * When true, enforce that the acting actor matches the request assignee
   * before allowing approve/reject. Default: false, but auto-enabled when
   * permissionRegistry is provided.
   */
  enforceAssignee?: boolean;
  /**
   * Optional PermissionRegistry from cap-permission.
   * When provided, enables richer assignee resolution:
   * - "role" assignee checks actor's permission groups (actor.groups)
   * - "group" assignee checks actor.groups membership
   * - "user" assignee checks actor.id match
   * Also auto-enables enforceAssignee unless explicitly set to false.
   * When not provided, falls back to basic checks (allow-all if enforceAssignee is false).
   */
  permissionRegistry?: PermissionRegistry;
}

export interface CreateApprovalOptions {
  action: string;
  entity?: string;
  recordId?: string;
  capability?: string;
  input: Record<string, unknown>;
  actor: Actor;
  executionId: string;
  effect: RequireApprovalEffect;
  triggerRules: string[];
  tenantId?: string;
  /** Override default assignee derived from level */
  assignee?: ApprovalAssignee;
  expiresAt?: Date;
  timeoutPolicy?: ApprovalTimeoutPolicy;
}

export interface ApprovalEngine {
  readonly store: ApprovalStore;

  /** Create an approval request from a require_approval rule effect */
  createRequest(options: CreateApprovalOptions): Promise<ApprovalPendingResult>;

  /** Approve a pending request and re-execute the original action */
  approve(input: ApproveInput, approver: Actor): Promise<ActionResult>;

  /** Reject a pending request */
  reject(input: RejectInput, approver: Actor): Promise<ApprovalRequest>;

  /** Cancel a pending request (only by the original initiator) */
  cancel(input: CancelInput, actor: Actor): Promise<ApprovalRequest>;

  /** Expire all overdue pending requests */
  expireOverdue(): Promise<ApprovalRequest[]>;

  /** Set the action executor for re-execution (allows deferred wiring) */
  setExecutor(executor: ActionExecutor): void;
}

/**
 * Create an ApprovalEngine instance.
 */
export function createApprovalEngine(options: ApprovalEngineOptions): ApprovalEngine {
  const { store, eventBus, permissionRegistry } = options;
  // Auto-enable assignee enforcement when permissionRegistry is provided,
  // unless explicitly set to false
  const enforceAssignee = options.enforceAssignee ?? permissionRegistry !== undefined;
  let executor = options.executor;
  const commandLayer = options.commandLayer;

  // Fix #5: Counter scoped inside factory to avoid module-level shared state
  let approvalCounter = 0;

  function generateApprovalId(): string {
    approvalCounter++;
    return `approval_${Date.now()}_${approvalCounter}`;
  }

  function setExecutor(exec: ActionExecutor): void {
    executor = exec;
  }

  async function emitEvent(event: EventRecord): Promise<void> {
    if (eventBus) {
      await eventBus.emit(event);
    }
  }

  /**
   * Check that the acting actor is authorized for the given assignee.
   * Only enforced when `enforceAssignee` is true in engine options.
   *
   * When permissionRegistry is available, uses it for richer resolution:
   * - system_admin group always passes (mirrors permission-engine behavior)
   * - "role" assignee: checks if actor belongs to a permission group matching the role
   * - "group"/"user" checks remain the same (they don't need the registry)
   *
   * Without permissionRegistry, falls back to basic Actor field checks.
   */
  function checkAssigneeAuthorization(actor: Actor, assignee: ApprovalAssignee): void {
    if (!enforceAssignee) return;

    // System actors (internal calls) bypass assignee checks
    if (actor.type === "system" && actor.id !== "anonymous") return;

    // When permissionRegistry is available, system_admin bypasses all checks
    if (permissionRegistry) {
      const isSystemAdmin =
        actor.groups.includes("system_admin") &&
        permissionRegistry.get("system_admin") !== undefined;
      if (isSystemAdmin) return;
    }

    switch (assignee.type) {
      case "user":
        if (actor.id !== assignee.value) {
          throw new Error(`Actor "${actor.id}" is not the assigned user "${assignee.value}"`);
        }
        break;
      case "group":
        if (!actor.groups?.includes(assignee.value)) {
          throw new Error(
            `Actor "${actor.id}" is not a member of assigned group "${assignee.value}"`,
          );
        }
        break;
      case "role":
        // With permissionRegistry: check if actor has a registered permission group
        // matching the role name. This provides proper role-based authorization
        // since LinchKit uses permission groups as the role mechanism.
        if (permissionRegistry) {
          const actorGroups = permissionRegistry.resolveActorPermissions(actor);
          const hasMatchingRole = actorGroups.some((g) => g.name === assignee.value);
          if (!hasMatchingRole) {
            throw new Error(
              `Actor "${actor.id}" does not have the assigned role "${assignee.value}" (no matching permission group)`,
            );
          }
        } else {
          // Fallback without registry: check metadata.role or groups membership
          if (actor.metadata?.role !== assignee.value && !actor.groups?.includes(assignee.value)) {
            throw new Error(
              `Actor "${actor.id}" does not have the assigned role "${assignee.value}"`,
            );
          }
        }
        break;
    }
  }

  async function createRequest(opts: CreateApprovalOptions): Promise<ApprovalPendingResult> {
    const id = generateApprovalId();
    const now = new Date();

    // Derive assignee from level if not explicitly provided
    const assignee: ApprovalAssignee = opts.assignee ?? {
      type: "role",
      value: opts.effect.level,
    };

    // Build merged reason from all trigger rules
    const reason = opts.effect.message ?? `Approval required (level: ${opts.effect.level})`;

    const request: ApprovalRequest = {
      id,
      action: opts.action,
      entity: opts.entity,
      recordId: opts.recordId,
      capability: opts.capability,
      input: opts.input,
      level: opts.effect.level,
      reason,
      triggerRules: opts.triggerRules,
      requestedBy: opts.actor,
      assignee,
      status: "pending",
      expiresAt: opts.expiresAt,
      timeoutPolicy: opts.timeoutPolicy ?? "none",
      originalExecutionId: opts.executionId,
      tenantId: opts.tenantId,
      createdAt: now,
      updatedAt: now,
    };

    // Fix #1: await store.create() since ApprovalStore.create() may return Promise<void>
    await store.create(request);

    // Emit approval.requested event
    await emitEvent(
      createApprovalEvent({
        type: "approval.requested",
        request,
        actor: opts.actor,
        executionId: opts.executionId,
        extraPayload: { triggerRules: opts.triggerRules },
      }),
    );

    return {
      status: "pending_approval",
      approvalId: id,
      message: reason,
      level: opts.effect.level,
    };
  }

  async function approve(input: ApproveInput, approver: Actor): Promise<ActionResult> {
    // Fix #4: Throw for not-found and non-pending (consistent with reject/cancel)
    const request = await store.getById(input.approvalId);
    if (!request) {
      throw new Error(`Approval request "${input.approvalId}" not found`);
    }

    if (request.status !== "pending") {
      throw new Error(`Approval request is not pending (current: ${request.status})`);
    }

    // Check expiration before processing
    if (request.expiresAt && request.expiresAt <= new Date()) {
      throw new Error("Approval request has expired");
    }

    // P1: Check assignee authorization (optional, controlled by enforceAssignee option)
    checkAssigneeAuthorization(approver, request.assignee);

    // Verify that either commandLayer or executor is available BEFORE updating status
    if (!commandLayer && !executor) {
      throw new Error("Action executor not configured — cannot re-execute");
    }

    // Update status to approved with decision metadata
    await store.update(input.approvalId, {
      status: "approved",
      decidedBy: approver,
      decidedAt: new Date(),
      decisionNote: input.note,
    });

    // Emit approval.approved event
    await emitEvent(
      createApprovalEvent({
        type: "approval.approved",
        request: { ...request, status: "approved" },
        actor: approver,
        executionId: request.originalExecutionId,
        extraPayload: { decidedBy: approver.id, note: input.note },
      }),
    );

    // Re-execute the original action.
    // Prefer CommandLayer (runs pre/tenant/pre-action/post-action, skips auth/exposure/permission).
    // Fall back to direct executor.execute() for backward compatibility.
    let result: ActionResult;

    if (commandLayer) {
      result = await commandLayer.execute({
        command: request.action,
        input: request.input,
        actor: request.requestedBy,
        tenantId: request.tenantId,
        channel: "internal",
        approvalId: input.approvalId,
        skipRules: request.triggerRules,
      });
    } else {
      // Backward-compatible fallback — direct executor call (deprecated path)
      // biome-ignore lint/style/noNonNullAssertion: checked above that either commandLayer or executor exists
      result = await executor!.execute(request.action, request.input, request.requestedBy, {
        skipExposureCheck: true,
        skipPermissionCheck: true,
        tenantId: request.tenantId,
        skipRules: request.triggerRules,
        approvalId: input.approvalId,
      });
    }

    // Fix #3: Update approval with execution result.
    // Status stays "approved" regardless of re-execution outcome.
    // If re-execution fails, we record the error but the approval decision stands —
    // the failure is an execution issue, not an approval issue.
    if (result.success) {
      await store.update(input.approvalId, {
        executionId: result.executionId,
      });
    } else {
      const errorMessage =
        typeof result.data === "object" && result.data !== null
          ? (result.data as Record<string, unknown>).error?.toString()
          : String(result.data);
      consoleLogger.warn(
        `[ApprovalEngine] Re-execution failed for approval "${input.approvalId}": ${errorMessage}`,
      );
      await store.update(input.approvalId, {
        executionId: result.executionId,
        executionError: errorMessage,
      });
    }

    return result;
  }

  async function reject(input: RejectInput, approver: Actor): Promise<ApprovalRequest> {
    // P2: Validate rejection note is non-empty
    if (!input.note || input.note.trim() === "") {
      throw new Error("Rejection note is required");
    }

    const request = await store.getById(input.approvalId);
    if (!request) {
      throw new Error(`Approval request "${input.approvalId}" not found`);
    }

    if (request.status !== "pending") {
      throw new Error(`Approval request is not pending (current: ${request.status})`);
    }

    // Check expiration before processing
    if (request.expiresAt && request.expiresAt <= new Date()) {
      throw new Error("Approval request has expired");
    }

    // P1: Check assignee authorization (optional, controlled by enforceAssignee option)
    checkAssigneeAuthorization(approver, request.assignee);

    const updated = await store.update(input.approvalId, {
      status: "rejected",
      decidedBy: approver,
      decidedAt: new Date(),
      decisionNote: input.note,
    });

    // Emit approval.rejected event
    await emitEvent(
      createApprovalEvent({
        type: "approval.rejected",
        request: updated ?? { ...request, status: "rejected" },
        actor: approver,
        executionId: request.originalExecutionId,
        extraPayload: { decidedBy: approver.id, note: input.note },
      }),
    );

    return updated ?? { ...request, status: "rejected" };
  }

  async function cancel(input: CancelInput, actor: Actor): Promise<ApprovalRequest> {
    const request = await store.getById(input.approvalId);
    if (!request) {
      throw new Error(`Approval request "${input.approvalId}" not found`);
    }

    if (request.status !== "pending") {
      throw new Error(`Approval request is not pending (current: ${request.status})`);
    }

    // Check expiration before processing
    if (request.expiresAt && request.expiresAt <= new Date()) {
      throw new Error("Approval request has expired");
    }

    // Only the original initiator can cancel
    if (request.requestedBy.id !== actor.id) {
      throw new Error("Only the original initiator can cancel an approval request");
    }

    const updated = await store.update(input.approvalId, {
      status: "cancelled",
    });

    // Emit approval.cancelled event
    await emitEvent(
      createApprovalEvent({
        type: "approval.cancelled",
        request: updated ?? { ...request, status: "cancelled" },
        actor,
        executionId: request.originalExecutionId,
      }),
    );

    return updated ?? { ...request, status: "cancelled" };
  }

  async function expireOverdue(): Promise<ApprovalRequest[]> {
    const expired = await store.getExpired();
    const results: ApprovalRequest[] = [];

    for (const request of expired) {
      if (request.timeoutPolicy === "none") {
        // No auto-action on timeout; leave pending
        continue;
      }

      const updated = await store.update(request.id, {
        status: "expired",
      });

      if (updated) {
        results.push(updated);

        // Emit approval.expired event
        await emitEvent(
          createApprovalEvent({
            type: "approval.expired",
            request: updated,
            actor: { type: "system", id: "system", groups: [] },
            executionId: request.originalExecutionId,
          }),
        );
      }
    }

    return results;
  }

  return {
    store,
    createRequest,
    approve,
    reject,
    cancel,
    expireOverdue,
    setExecutor,
  };
}

/**
 * Create a verifyApproval callback from an ApprovalStore.
 *
 * Returns true only when the approvalId exists AND has status "approved".
 * Use this to wire CommandLayerOptions.verifyApproval for secure approval re-execution.
 */
export function createApprovalVerifier(
  store: ApprovalStore,
): (approvalId: string) => Promise<boolean> {
  return async (approvalId: string): Promise<boolean> => {
    const request = await store.getById(approvalId);
    return !!request && request.status === "approved";
  };
}
