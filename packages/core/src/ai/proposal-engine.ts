/**
 * AI Proposal Engine
 *
 * Manages the lifecycle of AI-generated proposals derived from PatternInsights.
 * Proposals go through: draft → pending → approved/rejected.
 * Approved proposals can be applied to generate Rule/Automation/Schema changes.
 *
 * All proposals must pass AIBoundary/ProposalValidator checks before application.
 * AI cannot directly modify production — every change is a Proposal first.
 * See spec 09_proposal_validation_version.md and spec 22_ai_rule_boundary.md.
 */

import type { AutomationDefinition } from "../types/automation";
import type { RuleDefinition } from "../types/rule";
import type {
  ProposalValidatorConfig,
  ProposalValidationResult as SecurityValidationResult,
  ProposalChange as SecurityProposalChange,
} from "./proposal-validator";
import { validateProposal as validateProposalSecurity } from "./proposal-validator";
import type { PatternInsight } from "./pattern-detector";

// ── Proposal types ───────────────────────────────────────

export type ProposalType = "add_rule" | "add_automation" | "modify_schema" | "add_default";

export type AIProposalStatus = "draft" | "pending" | "approved" | "rejected" | "applied" | "rolled_back";

/** A draft suggestion from the pattern detector — not yet a full proposal */
export interface ProposalDraft {
  type: ProposalType;
  description: string;
  targetSchema: string;
  details: Record<string, unknown>;
}

/** The diff describing what a proposal would change */
export interface ProposalDiff {
  /** Type of definition being changed */
  target: "rule" | "automation" | "schema";
  /** What operation is being performed */
  operation: "create" | "update";
  /** The generated definition (for create/update) */
  definition?: RuleDefinition | AutomationDefinition | Record<string, unknown>;
  /** Human-readable summary of the change */
  summary: string;
}

/** A complete proposal with lifecycle state */
export interface Proposal {
  id: string;
  /** What type of change this proposes */
  type: ProposalType;
  /** Current lifecycle status */
  status: AIProposalStatus;
  /** Human-readable description */
  description: string;
  /** Why this change is being suggested */
  reasoning: string;
  /** Confidence from the underlying pattern insight (0-1) */
  confidence: number;
  /** What would change if approved */
  diff: ProposalDiff;
  /** The pattern insight that generated this proposal (if any) */
  insightId?: string;
  /** Timestamps */
  createdAt: Date;
  /** Who reviewed it */
  reviewedBy?: string;
  /** When it was reviewed */
  reviewedAt?: Date;
  /** Rejection reason (if rejected) */
  rejectionReason?: string;
  /** When it was applied (if applied) */
  appliedAt?: Date;
  /** When it was rolled back (if rolled back) */
  rolledBackAt?: Date;
}

// ── Proposal Engine Options ──────────────────────────────

export interface ProposalEngineOptions {
  /** Security validation config for proposals */
  validatorConfig?: ProposalValidatorConfig;
  /** Callback invoked when a proposal is applied (for external side effects) */
  onApply?: (proposal: Proposal) => void | Promise<void>;
  /** Callback invoked when a proposal is rolled back */
  onRollback?: (proposal: Proposal) => void | Promise<void>;
}

// ── Proposal Engine ──────────────────────────────────────

export class ProposalEngine {
  private readonly proposals: Map<string, Proposal> = new Map();
  private readonly validatorConfig?: ProposalValidatorConfig;
  private readonly onApply?: (proposal: Proposal) => void | Promise<void>;
  private readonly onRollback?: (proposal: Proposal) => void | Promise<void>;
  private idCounter = 0;

  constructor(options?: ProposalEngineOptions) {
    this.validatorConfig = options?.validatorConfig;
    this.onApply = options?.onApply;
    this.onRollback = options?.onRollback;
  }

  // ── Create proposals from insights ─────────────────────

  /**
   * Create a proposal from a PatternInsight.
   * The proposal starts in "draft" status.
   */
  createFromInsight(insight: PatternInsight): Proposal {
    const diff = this.buildDiff(insight);

    const proposal: Proposal = {
      id: this.nextId(),
      type: insight.suggestedAction.type,
      status: "draft",
      description: insight.suggestedAction.description,
      reasoning: insight.description,
      confidence: insight.confidence,
      diff,
      insightId: insight.id,
      createdAt: new Date(),
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Create a proposal directly (not from a pattern insight).
   */
  createProposal(params: {
    type: ProposalType;
    description: string;
    reasoning: string;
    confidence: number;
    diff: ProposalDiff;
  }): Proposal {
    const proposal: Proposal = {
      id: this.nextId(),
      type: params.type,
      status: "draft",
      description: params.description,
      reasoning: params.reasoning,
      confidence: params.confidence,
      diff: params.diff,
      createdAt: new Date(),
    };

    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  // ── Status transitions ─────────────────────────────────

  /**
   * Submit a draft proposal for review. Transitions draft → pending.
   * Validates against security rules before submission.
   */
  submit(proposalId: string): { success: boolean; validation?: SecurityValidationResult } {
    const proposal = this.getOrThrow(proposalId);

    if (proposal.status !== "draft") {
      throw new Error(`Cannot submit proposal "${proposalId}": status is "${proposal.status}", expected "draft"`);
    }

    // Run security validation
    const securityChanges = this.toSecurityChanges(proposal);
    const validation = validateProposalSecurity(securityChanges, this.validatorConfig);

    if (!validation.valid) {
      return { success: false, validation };
    }

    proposal.status = "pending";
    return { success: true, validation };
  }

  /**
   * Approve a pending proposal. Transitions pending → approved.
   */
  approve(proposalId: string, reviewedBy: string): Proposal {
    const proposal = this.getOrThrow(proposalId);

    if (proposal.status !== "pending") {
      throw new Error(
        `Cannot approve proposal "${proposalId}": status is "${proposal.status}", expected "pending"`,
      );
    }

    proposal.status = "approved";
    proposal.reviewedBy = reviewedBy;
    proposal.reviewedAt = new Date();
    return proposal;
  }

  /**
   * Reject a pending proposal. Transitions pending → rejected.
   */
  reject(proposalId: string, reviewedBy: string, reason: string): Proposal {
    const proposal = this.getOrThrow(proposalId);

    if (proposal.status !== "pending") {
      throw new Error(
        `Cannot reject proposal "${proposalId}": status is "${proposal.status}", expected "pending"`,
      );
    }

    proposal.status = "rejected";
    proposal.reviewedBy = reviewedBy;
    proposal.reviewedAt = new Date();
    proposal.rejectionReason = reason;
    return proposal;
  }

  /**
   * Apply an approved proposal. Transitions approved → applied.
   * Invokes the onApply callback for external side effects.
   */
  async apply(proposalId: string): Promise<Proposal> {
    const proposal = this.getOrThrow(proposalId);

    if (proposal.status !== "approved") {
      throw new Error(
        `Cannot apply proposal "${proposalId}": status is "${proposal.status}", expected "approved"`,
      );
    }

    if (this.onApply) {
      await this.onApply(proposal);
    }

    proposal.status = "applied";
    proposal.appliedAt = new Date();
    return proposal;
  }

  /**
   * Roll back an applied proposal. Transitions applied → rolled_back.
   * Invokes the onRollback callback for external side effects.
   */
  async rollback(proposalId: string): Promise<Proposal> {
    const proposal = this.getOrThrow(proposalId);

    if (proposal.status !== "applied") {
      throw new Error(
        `Cannot rollback proposal "${proposalId}": status is "${proposal.status}", expected "applied"`,
      );
    }

    if (this.onRollback) {
      await this.onRollback(proposal);
    }

    proposal.status = "rolled_back";
    proposal.rolledBackAt = new Date();
    return proposal;
  }

  // ── Queries ────────────────────────────────────────────

  /** Get a proposal by ID */
  get(proposalId: string): Proposal | undefined {
    return this.proposals.get(proposalId);
  }

  /** Get all proposals, optionally filtered by status */
  list(status?: AIProposalStatus): Proposal[] {
    const all = Array.from(this.proposals.values());
    if (status) {
      return all.filter((p) => p.status === status);
    }
    return all;
  }

  /** Get proposals for a specific schema */
  listBySchema(schema: string): Proposal[] {
    return Array.from(this.proposals.values()).filter(
      (p) => p.diff.definition && "schema" in (p.diff.definition as Record<string, unknown>) &&
        (p.diff.definition as Record<string, unknown>).schema === schema,
    );
  }

  /** Get the total count of proposals */
  get size(): number {
    return this.proposals.size;
  }

  /** Clear all proposals (useful for testing) */
  clear(): void {
    this.proposals.clear();
  }

  // ── Private helpers ────────────────────────────────────

  /** Build a ProposalDiff from a PatternInsight */
  private buildDiff(insight: PatternInsight): ProposalDiff {
    const draft = insight.suggestedAction;

    switch (draft.type) {
      case "add_rule":
        return {
          target: "rule",
          operation: "create",
          definition: this.buildRuleDefinition(insight),
          summary: draft.description,
        };

      case "add_automation":
        return {
          target: "automation",
          operation: "create",
          definition: this.buildAutomationDefinition(insight),
          summary: draft.description,
        };

      case "modify_schema":
      case "add_default":
        return {
          target: "schema",
          operation: "update",
          definition: {
            schema: insight.schema,
            ...draft.details,
          },
          summary: draft.description,
        };

      default:
        return {
          target: "rule",
          operation: "create",
          summary: draft.description,
        };
    }
  }

  /** Generate a RuleDefinition from a pattern insight */
  private buildRuleDefinition(insight: PatternInsight): RuleDefinition {
    const details = insight.suggestedAction.details;
    const field = details.field as string | undefined;
    const value = details.value;
    const action = details.action as string | undefined;

    if (insight.type === "validation_pattern") {
      // Build a validation rule
      return {
        name: `auto_validate_${field ?? "field"}_${Date.now()}`,
        label: `Auto-detected validation for ${field}`,
        description: insight.description,
        priority: 10,
        trigger: { action: action ?? `create_${insight.schema}` },
        condition: {
          field: field ?? "",
          operator: "not_null",
        },
        effect: {
          type: "block",
          message: `Field "${field}" must match the expected format`,
        },
      };
    }

    // Build a repetitive action auto-approval rule
    return {
      name: `auto_pattern_${insight.schema}_${Date.now()}`,
      label: `Auto-detected pattern for ${insight.schema}`,
      description: insight.description,
      priority: 10,
      trigger: { action: action ?? `update_${insight.schema}` },
      condition: field
        ? { field, operator: "eq", value }
        : { field: "id", operator: "not_null" },
      effect: {
        type: "enrich",
        setFields: field && value ? { [field]: value } : {},
      },
    };
  }

  /** Generate an AutomationDefinition from a pattern insight */
  private buildAutomationDefinition(insight: PatternInsight): AutomationDefinition {
    const details = insight.suggestedAction.details;

    if (insight.type === "timing") {
      const cron = (details.suggestedCron as string) ?? "0 9 * * *";
      const action = (details.action as string) ?? `process_${insight.schema}`;

      return {
        name: `auto_schedule_${action}_${Date.now()}`,
        description: insight.description,
        trigger: { type: "schedule", cron },
        actions: [
          {
            type: "execute_action",
            action,
            input: {},
          },
        ],
        enabled: true,
      };
    }

    if (insight.type === "state_flow") {
      const steps = (details.steps as string[]) ?? [];
      const fromState = steps[0];
      const toState = steps.length > 1 ? steps[1] : undefined;

      return {
        name: `auto_flow_${insight.schema}_${Date.now()}`,
        description: insight.description,
        trigger: {
          type: "stateChange",
          schema: insight.schema,
          from: fromState,
          to: toState,
        },
        actions: [
          {
            type: "send_notification",
            channel: "system",
            message: `Auto-detected state flow pattern: ${(details.path as string) ?? "unknown"}`,
          },
        ],
        enabled: true,
      };
    }

    // Fallback generic automation
    return {
      name: `auto_${insight.schema}_${Date.now()}`,
      description: insight.description,
      trigger: {
        type: "event",
        eventType: `${insight.schema}.updated`,
      },
      actions: [
        {
          type: "send_notification",
          channel: "system",
          message: insight.description,
        },
      ],
      enabled: true,
    };
  }

  /** Convert a Proposal to SecurityProposalChange[] for validation */
  private toSecurityChanges(proposal: Proposal): SecurityProposalChange[] {
    const typeMapping: Record<ProposalType, SecurityProposalChange["type"]> = {
      add_rule: "create_rule",
      add_automation: "create_flow",
      modify_schema: "modify_schema",
      add_default: "modify_schema",
    };

    const targetName = proposal.diff.definition
      ? ("name" in (proposal.diff.definition as Record<string, unknown>)
          ? String((proposal.diff.definition as Record<string, unknown>).name)
          : "unknown")
      : "unknown";

    return [
      {
        type: typeMapping[proposal.type],
        target: targetName,
        description: proposal.description,
      },
    ];
  }

  /** Get a proposal or throw if not found */
  private getOrThrow(proposalId: string): Proposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal "${proposalId}" not found`);
    }
    return proposal;
  }

  /** Generate a unique proposal ID */
  private nextId(): string {
    this.idCounter++;
    return `proposal-${Date.now()}-${this.idCounter}`;
  }
}
