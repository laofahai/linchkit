/**
 * AI Audit Logger
 *
 * Comprehensive audit logging for AI decisions. Tracks all AI inputs/outputs,
 * recommended actions, approval/rejection status, and provides a compliance-ready
 * audit trail format.
 *
 * See spec 27_ai_security.md §2.2 — "Audit Everything"
 */

import type { Logger } from "../types/logger";

// ── Audit Entry Types ───────────────────────────────────────

/** Categories of AI audit events */
export type AIAuditEventType =
  | "ai_call"
  | "ai_recommendation"
  | "ai_approval"
  | "ai_rejection"
  | "ai_prompt_injection"
  | "ai_pii_redaction"
  | "ai_boundary_violation"
  | "ai_proposal_generated"
  | "ai_proposal_applied"
  | "ai_data_access";

/** Risk level classification for audit entries */
export type AIAuditRiskLevel = "low" | "medium" | "high" | "critical";

/** A single entry in the AI audit trail */
export interface AIAuditEntry {
  /** Unique audit entry ID */
  id: string;

  /** ISO-8601 timestamp */
  timestamp: string;

  /** Event category */
  eventType: AIAuditEventType;

  /** Risk level assessment */
  riskLevel: AIAuditRiskLevel;

  /** Actor who initiated the AI operation */
  actorId?: string;

  /** Tenant context */
  tenantId?: string;

  /** AI model identifier (e.g. 'claude-3.5-sonnet') */
  agentModel?: string;

  /** Session identifier for correlating related AI calls */
  agentSessionId?: string;

  /** Parent human user who authorized this AI agent */
  parentUserId?: string;

  /** Token usage breakdown */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  /** Input sent to the AI (may be truncated for large prompts) */
  input?: string;

  /** Output received from the AI (may be truncated) */
  output?: string;

  /** Action name if AI was recommending or executing an action */
  actionName?: string;

  /** The recommendation or decision made by AI */
  recommendation?: string;

  /** Whether the recommendation was approved by a human */
  humanApproved?: boolean;

  /** Human reviewer ID (if reviewed) */
  reviewedBy?: string;

  /** Additional structured metadata */
  metadata?: Record<string, unknown>;

  /** PII fields that were redacted before this call */
  redactedFields?: string[];

  /** Prompt injection detection details */
  injectionDetection?: {
    detected: boolean;
    score: number;
    matchedPatterns: string[];
    action: "block" | "warn" | "log";
  };
}

/** Options for querying audit entries */
export interface AIAuditQueryOptions {
  /** Filter by event type */
  eventType?: AIAuditEventType;

  /** Filter by actor ID */
  actorId?: string;

  /** Filter by tenant ID */
  tenantId?: string;

  /** Filter by agent model */
  agentModel?: string;

  /** Filter by parent user ID */
  parentUserId?: string;

  /** Filter by session ID */
  agentSessionId?: string;

  /** Filter by risk level (returns this level and above) */
  minRiskLevel?: AIAuditRiskLevel;

  /** Filter entries after this timestamp (ISO-8601) */
  after?: string;

  /** Filter entries before this timestamp (ISO-8601) */
  before?: string;

  /** Maximum number of entries to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/** Configuration for the AI audit logger */
export interface AIAuditLoggerOptions {
  /** Logger for forwarding audit events to the system logger */
  logger?: Logger;

  /** Maximum number of in-memory entries before trimming (default: 50000) */
  maxEntries?: number;

  /** Maximum length for input/output fields before truncation (default: 10000) */
  maxContentLength?: number;

  /** Callback when an audit entry is created (for persistence) */
  onAuditEntry?: (entry: AIAuditEntry) => void;

  /** Whether to include full input/output in entries (default: true) */
  captureContent?: boolean;
}

// ── Risk Level Ordering ──────────────────────────────────────

const RISK_LEVEL_ORDER: Record<AIAuditRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── AI Audit Logger ──────────────────────────────────────────

export class AIAuditLogger {
  private readonly entries: AIAuditEntry[] = [];
  private readonly logger?: Logger;
  private readonly maxEntries: number;
  private readonly maxContentLength: number;
  private readonly onAuditEntry?: (entry: AIAuditEntry) => void;
  private readonly captureContent: boolean;
  private entryCounter = 0;

  constructor(options?: AIAuditLoggerOptions) {
    this.logger = options?.logger;
    this.maxEntries = options?.maxEntries ?? 50_000;
    this.maxContentLength = options?.maxContentLength ?? 10_000;
    this.onAuditEntry = options?.onAuditEntry;
    this.captureContent = options?.captureContent ?? true;
  }

  /** Log an AI call (input/output pair) */
  logCall(params: {
    actorId?: string;
    tenantId?: string;
    agentModel?: string;
    agentSessionId?: string;
    parentUserId?: string;
    input: string;
    output: string;
    actionName?: string;
    tokenUsage?: AIAuditEntry["tokenUsage"];
    metadata?: Record<string, unknown>;
    redactedFields?: string[];
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_call",
      riskLevel: "low",
      actorId: params.actorId,
      tenantId: params.tenantId,
      agentModel: params.agentModel,
      agentSessionId: params.agentSessionId,
      parentUserId: params.parentUserId,
      input: this.captureContent ? this.truncate(params.input) : undefined,
      output: this.captureContent ? this.truncate(params.output) : undefined,
      actionName: params.actionName,
      tokenUsage: params.tokenUsage,
      metadata: params.metadata,
      redactedFields: params.redactedFields,
    });
  }

  /** Log an AI recommendation (action suggested by AI) */
  logRecommendation(params: {
    actorId?: string;
    tenantId?: string;
    agentModel?: string;
    agentSessionId?: string;
    parentUserId?: string;
    actionName: string;
    recommendation: string;
    riskLevel?: AIAuditRiskLevel;
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_recommendation",
      riskLevel: params.riskLevel ?? "medium",
      actorId: params.actorId,
      tenantId: params.tenantId,
      agentModel: params.agentModel,
      agentSessionId: params.agentSessionId,
      parentUserId: params.parentUserId,
      actionName: params.actionName,
      recommendation: params.recommendation,
      metadata: params.metadata,
    });
  }

  /** Log approval of an AI recommendation */
  logApproval(params: {
    actorId?: string;
    tenantId?: string;
    actionName: string;
    recommendation: string;
    reviewedBy: string;
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_approval",
      riskLevel: "medium",
      actorId: params.actorId,
      tenantId: params.tenantId,
      actionName: params.actionName,
      recommendation: params.recommendation,
      humanApproved: true,
      reviewedBy: params.reviewedBy,
      metadata: params.metadata,
    });
  }

  /** Log rejection of an AI recommendation */
  logRejection(params: {
    actorId?: string;
    tenantId?: string;
    actionName: string;
    recommendation: string;
    reviewedBy: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_rejection",
      riskLevel: "medium",
      actorId: params.actorId,
      tenantId: params.tenantId,
      actionName: params.actionName,
      recommendation: params.recommendation,
      humanApproved: false,
      reviewedBy: params.reviewedBy,
      metadata: { ...params.metadata, rejectionReason: params.reason },
    });
  }

  /** Log a prompt injection detection event */
  logPromptInjection(params: {
    actorId?: string;
    tenantId?: string;
    input: string;
    score: number;
    matchedPatterns: string[];
    action: "block" | "warn" | "log";
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_prompt_injection",
      riskLevel: params.action === "block" ? "critical" : "high",
      actorId: params.actorId,
      tenantId: params.tenantId,
      input: this.captureContent ? this.truncate(params.input) : undefined,
      injectionDetection: {
        detected: true,
        score: params.score,
        matchedPatterns: params.matchedPatterns,
        action: params.action,
      },
      metadata: params.metadata,
    });
  }

  /** Log PII redaction before an external AI call */
  logPiiRedaction(params: {
    actorId?: string;
    tenantId?: string;
    redactedFields: string[];
    piiTypesFound: string[];
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_pii_redaction",
      riskLevel: "medium",
      actorId: params.actorId,
      tenantId: params.tenantId,
      redactedFields: params.redactedFields,
      metadata: {
        ...params.metadata,
        piiTypesFound: params.piiTypesFound,
      },
    });
  }

  /** Log an AI boundary violation (blocked by policy) */
  logBoundaryViolation(params: {
    actorId?: string;
    tenantId?: string;
    actionName?: string;
    violation: string;
    policyName?: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_boundary_violation",
      riskLevel: "high",
      actorId: params.actorId,
      tenantId: params.tenantId,
      actionName: params.actionName,
      metadata: {
        ...params.metadata,
        violation: params.violation,
        policyName: params.policyName,
        reason: params.reason,
      },
    });
  }

  /** Log AI data access (queries made by AI agents) */
  logDataAccess(params: {
    actorId?: string;
    tenantId?: string;
    agentModel?: string;
    agentSessionId?: string;
    parentUserId?: string;
    schemaName: string;
    queryType: "read" | "list" | "search";
    recordCount?: number;
    metadata?: Record<string, unknown>;
  }): AIAuditEntry {
    return this.addEntry({
      eventType: "ai_data_access",
      riskLevel: "low",
      actorId: params.actorId,
      tenantId: params.tenantId,
      agentModel: params.agentModel,
      agentSessionId: params.agentSessionId,
      parentUserId: params.parentUserId,
      metadata: {
        ...params.metadata,
        schemaName: params.schemaName,
        queryType: params.queryType,
        recordCount: params.recordCount,
      },
    });
  }

  // ── Query Methods ──────────────────────────────────────

  /** Query audit entries with filters */
  query(options?: AIAuditQueryOptions): AIAuditEntry[] {
    let results = [...this.entries];

    if (options?.eventType) {
      results = results.filter((e) => e.eventType === options.eventType);
    }
    if (options?.actorId) {
      results = results.filter((e) => e.actorId === options.actorId);
    }
    if (options?.tenantId) {
      results = results.filter((e) => e.tenantId === options.tenantId);
    }
    if (options?.agentModel) {
      results = results.filter((e) => e.agentModel === options.agentModel);
    }
    if (options?.parentUserId) {
      results = results.filter((e) => e.parentUserId === options.parentUserId);
    }
    if (options?.agentSessionId) {
      results = results.filter((e) => e.agentSessionId === options.agentSessionId);
    }
    if (options?.minRiskLevel) {
      const minOrder = RISK_LEVEL_ORDER[options.minRiskLevel];
      results = results.filter((e) => RISK_LEVEL_ORDER[e.riskLevel] >= minOrder);
    }
    if (options?.after) {
      const afterTime = new Date(options.after).getTime();
      results = results.filter((e) => new Date(e.timestamp).getTime() > afterTime);
    }
    if (options?.before) {
      const beforeTime = new Date(options.before).getTime();
      results = results.filter((e) => new Date(e.timestamp).getTime() < beforeTime);
    }

    // Sort most recent first (by ID suffix as tiebreaker for same-millisecond entries)
    results.sort((a, b) => {
      const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      if (timeDiff !== 0) return timeDiff;
      // Extract sequence number from ID (format: "audit-{timestamp}-{seq}")
      const seqA = Number.parseInt(a.id.split("-").pop() ?? "0", 10);
      const seqB = Number.parseInt(b.id.split("-").pop() ?? "0", 10);
      return seqB - seqA;
    });

    if (options?.offset) {
      results = results.slice(options.offset);
    }
    if (options?.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /** Get total count of entries (optionally filtered) */
  count(options?: Pick<AIAuditQueryOptions, "eventType" | "tenantId" | "minRiskLevel">): number {
    if (!options) return this.entries.length;
    return this.query({ ...options, limit: undefined }).length;
  }

  /** Export all entries as a JSON-serializable compliance report */
  exportReport(options?: AIAuditQueryOptions): {
    generatedAt: string;
    totalEntries: number;
    entries: AIAuditEntry[];
    summary: {
      byEventType: Record<string, number>;
      byRiskLevel: Record<string, number>;
    };
  } {
    const entries = this.query(options);
    const byEventType: Record<string, number> = {};
    const byRiskLevel: Record<string, number> = {};

    for (const entry of entries) {
      byEventType[entry.eventType] = (byEventType[entry.eventType] ?? 0) + 1;
      byRiskLevel[entry.riskLevel] = (byRiskLevel[entry.riskLevel] ?? 0) + 1;
    }

    return {
      generatedAt: new Date().toISOString(),
      totalEntries: entries.length,
      entries,
      summary: { byEventType, byRiskLevel },
    };
  }

  /** Clear all entries (for testing) */
  clear(): void {
    this.entries.length = 0;
  }

  // ── Private ────────────────────────────────────────────

  private addEntry(partial: Omit<AIAuditEntry, "id" | "timestamp">): AIAuditEntry {
    this.entryCounter += 1;
    const entry: AIAuditEntry = {
      id: `audit-${Date.now()}-${this.entryCounter}`,
      timestamp: new Date().toISOString(),
      ...partial,
    };

    // Trim if at capacity (remove oldest half)
    if (this.entries.length >= this.maxEntries) {
      this.entries.splice(0, this.entries.length >> 1);
    }

    this.entries.push(entry);
    this.onAuditEntry?.(entry);

    // Forward to system logger
    this.logger?.info(`AI audit: ${entry.eventType}`, {
      auditId: entry.id,
      eventType: entry.eventType,
      riskLevel: entry.riskLevel,
      actorId: entry.actorId,
      tenantId: entry.tenantId,
      actionName: entry.actionName,
      agentModel: entry.agentModel,
    });

    return entry;
  }

  private truncate(content: string): string {
    if (content.length <= this.maxContentLength) {
      return content;
    }
    return `${content.slice(0, this.maxContentLength)}... [truncated, ${content.length} chars total]`;
  }
}
