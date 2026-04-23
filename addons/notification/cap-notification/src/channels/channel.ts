/**
 * NotificationChannel — dispatch interface for a single delivery channel.
 *
 * Every channel implementation (in-app, email, webhook, ...) implements this
 * contract. The default in-app channel persists to the `notification` entity;
 * other channels are stubs for now.
 */

// ── Domain types ────────────────────────────────────────────

/** Supported channel identifiers. Extend this union when new channels ship. */
export type NotificationChannelName = "in_app" | "email" | "webhook";

/**
 * Request payload passed to a channel's `send()` method.
 * The channel is responsible for interpreting fields it understands
 * (subject for email, url for webhook, etc.) and ignoring the rest.
 */
export interface NotificationDispatchRequest {
  recipientId: string;
  title?: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
  tenantId?: string;
}

/**
 * Outcome of a single channel dispatch.
 * `id` is the persisted notification id when the channel stores a record
 * (in_app); transport-only channels (email/webhook) MAY return `null`.
 */
export interface NotificationDispatchResult {
  channel: NotificationChannelName;
  delivered: boolean;
  id: string | null;
  /** When delivered = false, an explanation suitable for logs/UI */
  reason?: string;
}

/**
 * Minimal context a channel needs to perform its work. Concrete channels
 * receive this from the capability factory at dispatch time.
 */
export interface NotificationChannelContext {
  /** Actor id to record as created_by on any persisted row */
  actorId: string;
  /** Current tenant id, if any */
  tenantId?: string;
}

export interface NotificationChannel {
  /** Stable channel identifier (must match NotificationChannelName) */
  readonly name: NotificationChannelName;
  /**
   * Dispatch a single notification. Implementations MUST be non-throwing for
   * expected business failures (e.g. recipient opted out) and instead return
   * `{ delivered: false, reason }`. Unexpected errors may throw.
   */
  send(
    request: NotificationDispatchRequest,
    context: NotificationChannelContext,
  ): Promise<NotificationDispatchResult>;
}
