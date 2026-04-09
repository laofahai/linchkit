/**
 * AI Action Audit Store
 *
 * In-memory store for tracking AI-initiated action modifications.
 * Provides queryable history with tenant isolation and immutable entries.
 *
 * See spec 27_ai_security.md §2.2 — "Audit Everything"
 */

// ── AI Action Audit Entry ───────────────────────────────────

/** Extended audit entry specifically for AI-initiated action modifications */
export interface AIActionAuditEntry {
  /** Unique entry ID */
  readonly id: string;

  /** When the action was attempted */
  readonly timestamp: Date;

  /** AI actor identifier */
  readonly actor: string;

  /** Action name (e.g. "update_order") */
  readonly action: string;

  /** Target entity name */
  readonly entity: string;

  /** AI modification level used */
  readonly modificationLevel: "read_only" | "suggest" | "auto_safe" | "auto_all";

  /** Whether the action was approved */
  readonly approved: boolean;

  /** Who approved (undefined if auto-approved or not yet approved) */
  readonly approvedBy?: string;

  /** AI confidence score (0-1) */
  readonly confidence: number;

  /** Optional tenant context */
  readonly tenantId?: string;

  /** Additional structured metadata */
  readonly metadata?: Record<string, unknown>;
}

/** Options for querying AIActionAuditEntry records */
export interface AIActionAuditQueryOptions {
  /** Filter by entity name */
  entity?: string;

  /** Filter by action name */
  action?: string;

  /** Filter entries after this date */
  after?: Date;

  /** Filter entries before this date */
  before?: Date;

  /** Filter by approval status */
  approved?: boolean;

  /** Filter by actor */
  actor?: string;

  /** Filter by tenant ID */
  tenantId?: string;

  /** Maximum entries to return */
  limit?: number;
}

// ── AI Action Audit Store ───────────────────────────────────

/**
 * In-memory store for AI action audit entries.
 * Tracks all AI-initiated modifications with queryable history.
 * Entries are frozen on storage for immutability.
 */
export class AIActionAuditStore {
  private readonly entries: AIActionAuditEntry[] = [];
  private readonly maxEntries: number;
  constructor(maxEntries = 50_000) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  /** Record a new AI action audit entry. Returns a frozen entry. */
  record(params: Omit<AIActionAuditEntry, "id" | "timestamp">): AIActionAuditEntry {
    const entry: AIActionAuditEntry = Object.freeze({
      ...params,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    });

    // Trim oldest half when at capacity
    if (this.entries.length >= this.maxEntries) {
      this.entries.splice(0, Math.max(1, this.entries.length >> 1));
    }

    this.entries.push(entry);
    return entry;
  }

  /** Query audit entries with filters */
  query(options?: AIActionAuditQueryOptions): AIActionAuditEntry[] {
    let results = [...this.entries];

    if (options?.entity) {
      results = results.filter((e) => e.entity === options.entity);
    }
    if (options?.action) {
      results = results.filter((e) => e.action === options.action);
    }
    if (options?.actor) {
      results = results.filter((e) => e.actor === options.actor);
    }
    if (options?.tenantId) {
      results = results.filter((e) => e.tenantId === options.tenantId);
    }
    if (options?.approved !== undefined) {
      results = results.filter((e) => e.approved === options.approved);
    }
    if (options?.after) {
      const afterTime = options.after.getTime();
      results = results.filter((e) => e.timestamp.getTime() > afterTime);
    }
    if (options?.before) {
      const beforeTime = options.before.getTime();
      results = results.filter((e) => e.timestamp.getTime() < beforeTime);
    }

    // Most recent first
    results.reverse();

    if (options?.limit !== undefined && options.limit >= 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /** Get total entry count */
  get size(): number {
    return this.entries.length;
  }

  /** Clear all entries (for testing) */
  clear(): void {
    this.entries.length = 0;
  }
}
