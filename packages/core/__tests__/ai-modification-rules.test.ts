import { describe, expect, test } from "bun:test";
import { AIModificationRuleRegistry } from "../src/ai/ai-modification-rules";
import { classifyActionRisk, requiresHumanApproval } from "../src/ai/human-in-loop";

// ── AIModificationRuleRegistry ──────────────────────────

describe("AIModificationRuleRegistry", () => {
  test("default deny when no rules registered", () => {
    const reg = new AIModificationRuleRegistry();
    const result = reg.canModify("order", undefined, "suggest");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.effectiveLevel).toBe("read_only");
  });

  test("entity-wide rule allows matching level", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({ entity: "order", level: "suggest", requiresApproval: true, reason: "test" });
    const result = reg.canModify("order", undefined, "suggest");
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.matchedRule?.entity).toBe("order");
  });

  test("denies when requested level exceeds granted", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({ entity: "order", level: "suggest", requiresApproval: true, reason: "test" });
    const result = reg.canModify("order", undefined, "auto_all");
    expect(result.allowed).toBe(false);
  });

  test("read_only always denies modification", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({ entity: "user", level: "read_only", requiresApproval: true, reason: "PII" });
    const result = reg.canModify("user", undefined, "suggest");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("read-only");
  });

  test("field-specific rule takes priority over entity-wide", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({
      entity: "order",
      level: "auto_safe",
      requiresApproval: false,
      reason: "entity",
    });
    reg.register({
      entity: "order",
      fields: ["total"],
      level: "read_only",
      requiresApproval: true,
      reason: "financial",
    });
    // Field-specific rule wins for 'total'
    expect(reg.canModify("order", "total", "suggest").allowed).toBe(false);
    // Entity-wide rule applies for other fields
    expect(reg.canModify("order", "notes", "suggest").allowed).toBe(true);
  });

  test("getRulesForEntity returns only matching rules", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({ entity: "order", level: "suggest", requiresApproval: true, reason: "a" });
    reg.register({ entity: "user", level: "read_only", requiresApproval: true, reason: "b" });
    expect(reg.getRulesForEntity("order")).toHaveLength(1);
    expect(reg.getRulesForEntity("product")).toHaveLength(0);
  });

  test("registerAll adds multiple rules", () => {
    const reg = new AIModificationRuleRegistry();
    reg.registerAll([
      { entity: "a", level: "suggest", requiresApproval: true, reason: "x" },
      { entity: "b", level: "auto_safe", requiresApproval: false, reason: "y" },
    ]);
    expect(reg.getAllRules()).toHaveLength(2);
  });

  test("clear removes all rules", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({ entity: "a", level: "suggest", requiresApproval: true, reason: "x" });
    reg.clear();
    expect(reg.getAllRules()).toHaveLength(0);
  });

  test("auto_all grants all levels", () => {
    const reg = new AIModificationRuleRegistry();
    reg.register({
      entity: "note",
      level: "auto_all",
      requiresApproval: false,
      reason: "low risk",
    });
    expect(reg.canModify("note", undefined, "auto_all").allowed).toBe(true);
    expect(reg.canModify("note", undefined, "suggest").allowed).toBe(true);
  });
});

// ── classifyActionRisk ──────────────────────────────────

describe("classifyActionRisk", () => {
  test("critical for drop/terminate/shutdown patterns", () => {
    expect(classifyActionRisk("drop_table")).toBe("critical");
    expect(classifyActionRisk("terminate_session")).toBe("critical");
    expect(classifyActionRisk("shutdown_server")).toBe("critical");
  });

  test("high for delete/transfer/pay patterns", () => {
    expect(classifyActionRisk("delete_order")).toBe("high");
    expect(classifyActionRisk("transfer_funds")).toBe("high");
    expect(classifyActionRisk("pay_invoice")).toBe("high");
  });

  test("high when financial impact > 10000", () => {
    expect(classifyActionRisk("update_price", { financialImpact: 50000 })).toBe("high");
  });

  test("medium when affected records > 100", () => {
    expect(classifyActionRisk("update_status", { affectedRecords: 500 })).toBe("medium");
  });

  test("low for normal actions", () => {
    expect(classifyActionRisk("create_note")).toBe("low");
    expect(classifyActionRisk("update_title")).toBe("low");
  });

  test("custom high-risk patterns", () => {
    expect(classifyActionRisk("archive_order", undefined, ["archive_*"])).toBe("high");
  });
});

// ── requiresHumanApproval ───────────────────────────────

describe("requiresHumanApproval", () => {
  const aiCtx = { confidence: 0.9, isAIInitiated: true };

  test("human-initiated actions never require AI approval", () => {
    const result = requiresHumanApproval("delete_order", { confidence: 0.1, isAIInitiated: false });
    expect(result.requiresApproval).toBe(false);
  });

  test("critical-risk always requires approval", () => {
    const result = requiresHumanApproval("drop_table", aiCtx);
    expect(result.requiresApproval).toBe(true);
    expect(result.riskCategory).toBe("critical");
  });

  test("high-risk always requires approval", () => {
    const result = requiresHumanApproval("delete_order", aiCtx);
    expect(result.requiresApproval).toBe(true);
    expect(result.riskCategory).toBe("high");
  });

  test("below policy threshold requires approval", () => {
    const result = requiresHumanApproval(
      "update_order",
      { confidence: 0.5, isAIInitiated: true },
      {
        policies: [{ action: "update_order", threshold: 0.7 }],
      },
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain("below policy threshold");
  });

  test("above policy threshold does not require approval", () => {
    const result = requiresHumanApproval(
      "update_order",
      { confidence: 0.9, isAIInitiated: true },
      {
        policies: [{ action: "update_order", threshold: 0.7 }],
      },
    );
    expect(result.requiresApproval).toBe(false);
  });

  test("below default threshold requires approval", () => {
    const result = requiresHumanApproval("create_note", { confidence: 0.5, isAIInitiated: true });
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain("default threshold");
  });

  test("above default threshold does not require approval", () => {
    const result = requiresHumanApproval("create_note", { confidence: 0.9, isAIInitiated: true });
    expect(result.requiresApproval).toBe(false);
  });

  test("policy approverRole is returned", () => {
    const result = requiresHumanApproval(
      "update_order",
      { confidence: 0.3, isAIInitiated: true },
      {
        policies: [{ action: "update_order", threshold: 0.7, approverRole: "manager" }],
      },
    );
    expect(result.approverRole).toBe("manager");
  });
});
