import { describe, expect, it } from "bun:test";
import type { ProposalChange } from "../src/ai/proposal-validator";
import {
  createProposalValidator,
  validateProposal,
} from "../src/ai/proposal-validator";

// ── Helpers ────────────────────────────────────────────────────

function change(type: ProposalChange["type"], target: string): ProposalChange {
  return { type, target };
}

// ── Basic Validation ───────────────────────────────────────────

describe("validateProposal", () => {
  describe("forbidden changes", () => {
    it("blocks delete_rule by default", () => {
      const result = validateProposal([change("delete_rule", "amount_limit_rule")]);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].ruleName).toBe("forbidden_change");
      expect(result.violations[0].reason).toContain("delete_rule");
    });

    it("blocks modify_permission by default", () => {
      const result = validateProposal([change("modify_permission", "admin_group")]);
      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toContain("modify_permission");
    });

    it("blocks delete_permission by default", () => {
      const result = validateProposal([change("delete_permission", "viewer_group")]);
      expect(result.valid).toBe(false);
    });

    it("blocks delete_schema by default", () => {
      const result = validateProposal([change("delete_schema", "purchase_request")]);
      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toContain("delete_schema");
    });

    it("blocks multiple forbidden changes and reports all", () => {
      const result = validateProposal([
        change("delete_rule", "rule_a"),
        change("modify_permission", "group_b"),
        change("delete_schema", "schema_c"),
      ]);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(3);
    });

    it("allows configuring custom forbidden changes", () => {
      const result = validateProposal(
        [change("create_flow", "dangerous_flow")],
        { forbiddenChanges: ["create_flow"] },
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].reason).toContain("create_flow");
    });
  });

  describe("allowed changes", () => {
    it("passes valid non-forbidden changes", () => {
      const result = validateProposal([
        change("create_schema", "new_product"),
        change("create_action", "submit_order"),
      ]);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("passes empty proposals with warning", () => {
      const result = validateProposal([]);
      expect(result.valid).toBe(true);
      expect(result.requiresHumanApproval).toBe(false);
      expect(result.warnings).toContain("Empty proposal — no changes to validate");
    });
  });

  describe("risk level assessment", () => {
    it("classifies delete operations as critical risk", () => {
      const result = validateProposal(
        [change("delete_action", "some_action")],
        { forbiddenChanges: [] },
      );
      expect(result.riskLevel).toBe("critical");
    });

    it("classifies modify operations as high risk", () => {
      const result = validateProposal(
        [change("modify_schema", "product")],
        { forbiddenChanges: [] },
      );
      expect(result.riskLevel).toBe("high");
    });

    it("classifies create operations as medium risk", () => {
      const result = validateProposal(
        [change("create_action", "new_action")],
        { forbiddenChanges: [] },
      );
      expect(result.riskLevel).toBe("medium");
    });

    it("returns highest risk level across all changes", () => {
      const result = validateProposal(
        [
          change("create_action", "safe_action"),   // medium
          change("modify_schema", "product"),         // high
        ],
        { forbiddenChanges: [] },
      );
      expect(result.riskLevel).toBe("high");
    });
  });

  describe("human approval requirements", () => {
    it("requires human approval by default (M2)", () => {
      const result = validateProposal([change("create_schema", "product")]);
      expect(result.requiresHumanApproval).toBe(true);
    });

    it("respects requireHumanApprovalForAll=false", () => {
      const result = validateProposal(
        [change("create_schema", "product")],
        { requireHumanApprovalForAll: false },
      );
      // Still requires approval because create_schema is in default requireApprovalFor
      expect(result.requiresHumanApproval).toBe(true);
    });

    it("does not require approval for empty proposals", () => {
      const result = validateProposal([]);
      expect(result.requiresHumanApproval).toBe(false);
    });
  });

  describe("change count limits", () => {
    it("rejects proposals exceeding max changes", () => {
      const changes = Array.from({ length: 60 }, (_, i) =>
        change("create_action", `action_${i}`),
      );
      const result = validateProposal(changes);
      expect(result.valid).toBe(false);
      expect(result.violations.some((v) => v.ruleName === "max_changes_exceeded")).toBe(true);
    });

    it("respects custom max changes limit", () => {
      const changes = Array.from({ length: 6 }, (_, i) =>
        change("create_action", `action_${i}`),
      );
      const result = validateProposal(changes, { maxChangesPerProposal: 5 });
      expect(result.valid).toBe(false);
    });
  });

  describe("sensitive entities", () => {
    it("warns when changing sensitive entities", () => {
      const result = validateProposal(
        [change("modify_schema", "user_profile")],
        {
          forbiddenChanges: [],
          sensitiveEntities: ["user_profile", "payment_info"],
        },
      );
      expect(result.warnings.some((w) => w.includes("sensitive entity"))).toBe(true);
      expect(result.requiresHumanApproval).toBe(true);
    });

    it("bumps risk to at least high for sensitive entities", () => {
      const result = validateProposal(
        [change("create_action", "user_profile")],
        {
          forbiddenChanges: [],
          sensitiveEntities: ["user_profile"],
        },
      );
      // create_action is normally medium, but sensitive entity bumps to high
      expect(result.riskLevel).toBe("high");
    });
  });

  describe("custom rules", () => {
    it("applies custom validation rules", () => {
      const result = validateProposal(
        [change("modify_schema", "audit_log")],
        {
          forbiddenChanges: [],
          customRules: [
            {
              name: "no_audit_modification",
              validate: (c) =>
                c.target === "audit_log"
                  ? "Audit log schema cannot be modified"
                  : undefined,
            },
          ],
        },
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].ruleName).toBe("no_audit_modification");
    });

    it("passes custom rules when no violation", () => {
      const result = validateProposal(
        [change("modify_schema", "product")],
        {
          forbiddenChanges: [],
          customRules: [
            {
              name: "no_audit_modification",
              validate: (c) =>
                c.target === "audit_log"
                  ? "Cannot modify audit log"
                  : undefined,
            },
          ],
        },
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("entity repetition warning", () => {
    it("warns when an entity has many changes", () => {
      const changes = Array.from({ length: 8 }, () =>
        change("modify_schema", "product"),
      );
      const result = validateProposal(changes, { forbiddenChanges: [] });
      expect(result.warnings.some((w) => w.includes("product") && w.includes("8 changes"))).toBe(
        true,
      );
    });
  });
});

// ── createProposalValidator ───────────────────────────────────

describe("createProposalValidator", () => {
  it("creates a reusable validator with preset config", () => {
    const validator = createProposalValidator({
      forbiddenChanges: ["delete_flow"],
      maxChangesPerProposal: 10,
    });

    const result1 = validator.validate([change("delete_flow", "my_flow")]);
    expect(result1.valid).toBe(false);

    const result2 = validator.validate([change("create_action", "safe_action")]);
    expect(result2.valid).toBe(true);
  });

  it("exposes config for inspection", () => {
    const validator = createProposalValidator({
      forbiddenChanges: ["delete_schema"],
    });
    expect(validator.config.forbiddenChanges).toEqual(["delete_schema"]);
  });
});
