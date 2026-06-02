/**
 * cap-lock override notification seam (Spec 63 §4.2 "Notification — Notify
 * stakeholders when locked fields are force-modified").
 *
 * The `field-lock-check` interceptor suppresses lock violations under one of its
 * policy escape hatches (shadow / bypass / tolerance / soft). When that happens a
 * locked field is being force-modified, so cap-lock emits a structured
 * `lock.override` event through an INJECTED sink — mirroring exactly how the
 * audit `logger` is injected. cap-lock takes ZERO notification/event-bus
 * dependency: the host decides where the event goes (an EventHandler →
 * send_notification, the execution log, etc.). When no sink is injected, no event
 * is emitted and behavior is byte-identical to core's default enforcement.
 */

import type { FieldLockCheckContext, FieldLockViolation } from "@linchkit/core";
// Type-only import: does NOT create a runtime cycle, so the builder can live here
// while the interceptor imports `buildLockOverrideEvent` back. The public
// `LockSuppressionReason` export from index.ts continues to come from the
// interceptor module.
import type { LockSuppressionReason } from "./field-lock-interceptor";

/** Discriminant/type tag for the override notification event. */
export const LOCK_OVERRIDE_EVENT = "lock.override" as const;

/**
 * Structured event emitted once per suppression, 1:1 with the audit log, when a
 * locked field is force-modified. The host maps this to a notification or an
 * execution-log entry.
 */
export interface LockOverrideEvent {
  /** Always "lock.override". */
  type: typeof LOCK_OVERRIDE_EVENT;
  /** Which policy escape hatch allowed the write. */
  reason: LockSuppressionReason;
  /** Entity whose locked field(s) were force-modified. */
  entity: string;
  /** The persisted record's id, when present on the context record. */
  recordId?: string;
  /** Actor who performed the override. */
  actorId: string;
  actorType: string;
  /** Tenant scope, when known. */
  tenantId?: string;
  /** Field names whose lock violations were suppressed. */
  fields: string[];
}

/**
 * Pure builder for a {@link LockOverrideEvent}. Mirrors the audit context shape:
 * the `fields`/`reason` come from the audited violation subset so the event is
 * 1:1 with the audit-log entry. Coerces `record.id` safely (it is
 * `Record<string, unknown>`) and only surfaces it when it is a string.
 */
export function buildLockOverrideEvent(opts: {
  reason: LockSuppressionReason;
  context: FieldLockCheckContext;
  violations: readonly FieldLockViolation[];
}): LockOverrideEvent {
  const { reason, context, violations } = opts;
  const rawId = context.record.id;
  return {
    type: LOCK_OVERRIDE_EVENT,
    reason,
    entity: context.entity,
    recordId: typeof rawId === "string" ? rawId : undefined,
    actorId: context.actor.id,
    actorType: context.actor.type,
    tenantId: context.tenantId,
    fields: violations.map((v) => v.field),
  };
}
