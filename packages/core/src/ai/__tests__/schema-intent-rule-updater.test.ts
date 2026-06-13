/**
 * Tests for `draftRuleUpdate` — sourcePatch assembly (#566).
 *
 * The "say→change the manager-approval threshold to 20000" path must turn a
 * CODE-condition rule update into a governed draft whose change carries a
 * structured `sourcePatch { filePath, constantName, newValueLiteral }`, so that
 * graduation rewrites the real `export const MANAGER_APPROVAL_THRESHOLD = 10000`.
 *
 * The `ai` Proposal model carries its single change as `proposal.diff`, so "the
 * change" here is `proposal.diff.sourcePatch`; the outcome mirrors it on
 * `outcome.sourcePatch` for the adapter-server route to copy onto the governed
 * `ProposalChange.sourcePatch`. These tests pin BOTH carriers, plus the
 * negative cases where no `sourcePatch` must be built.
 */

import { describe, expect, it } from "bun:test";
import { ProposalEngine } from "../proposal-engine";
import type { ParsedSchemaIntent } from "../schema-intent-prompt";
import { draftRuleUpdate } from "../schema-intent-rule-updater";
import type { SchemaIntentEntity, SchemaIntentRule } from "../schema-intent-types";

const DEMO_PATCH_PATH = "addons/demo/cap-purchase-demo/src/rules/manager-approval-threshold.ts";

/** A CODE-condition rule snapshot that opted into graduation via `patchTarget`. */
function codeRuleWithPatchTarget(overrides: Partial<SchemaIntentRule> = {}): SchemaIntentRule {
  return {
    name: "manager_approval_threshold",
    label: "Manager approval threshold",
    description: "Requires manager approval when the amount exceeds 10000",
    triggerActions: ["approve_purchase_request"],
    effectType: "block",
    conditionKind: "code",
    patchTarget: { sourcePath: DEMO_PATCH_PATH, constantName: "MANAGER_APPROVAL_THRESHOLD" },
    ...overrides,
  };
}

/** Wrap one rule snapshot in the entity the resolver consumes. */
function entityWithRule(rule: SchemaIntentRule): SchemaIntentEntity {
  return {
    name: "purchase_request",
    label: "Purchase Request",
    fields: [{ name: "amount", type: "number", required: true }],
    actionNames: ["approve_purchase_request"],
    rules: [rule],
  };
}

/** A parsed `update_rule` intent targeting the demo rule. */
function parsedUpdate(overrides: Partial<ParsedSchemaIntent> = {}): ParsedSchemaIntent {
  return {
    kind: "update_rule",
    targetEntity: "purchase_request",
    ruleName: "manager_approval_threshold",
    diff: "Change the manager-approval threshold from 10000 to 20000.",
    confidence: 0.9,
    explanation: "把经理审批阈值改成2万。",
    ...overrides,
  };
}

function runDraft(opts: { parsed: ParsedSchemaIntent; rule: SchemaIntentRule }) {
  const entity = entityWithRule(opts.rule);
  return draftRuleUpdate({
    parsed: opts.parsed,
    entity,
    confidence: 0.9,
    utterance: "把经理审批阈值改成2万",
    engine: new ProposalEngine(),
  });
}

describe("draftRuleUpdate — sourcePatch assembly (#566)", () => {
  it("assembles a sourcePatch for a code rule with patchTarget + safe newValueLiteral", () => {
    const outcome = runDraft({
      parsed: parsedUpdate({ newValueLiteral: "20000" }),
      rule: codeRuleWithPatchTarget(),
    });

    expect(outcome.kind).toBe("proposal_draft");
    if (outcome.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    expect(outcome.requiresCodeChange).toBe(true);

    const expected = {
      filePath: DEMO_PATCH_PATH,
      constantName: "MANAGER_APPROVAL_THRESHOLD",
      newValueLiteral: "20000",
    };
    // The change (proposal.diff) carries the assembled patch…
    expect(outcome.proposal.diff.sourcePatch).toEqual(expected);
    // …and the outcome mirrors it for the route to copy onto the governed change.
    expect(outcome.sourcePatch).toEqual(expected);
    // No fabricated declarative definition — this stays an honest code change.
    expect(outcome.proposal.diff.definition).toBeUndefined();
  });

  it("builds NO sourcePatch when newValueLiteral is absent", () => {
    const outcome = runDraft({
      parsed: parsedUpdate(), // no newValueLiteral
      rule: codeRuleWithPatchTarget(),
    });
    expect(outcome.kind).toBe("proposal_draft");
    if (outcome.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    expect(outcome.sourcePatch).toBeUndefined();
    expect(outcome.proposal.diff.sourcePatch).toBeUndefined();
    // Still an honest diff-only change-request.
    expect(outcome.requiresCodeChange).toBe(true);
  });

  it("builds NO sourcePatch from an UNSAFE newValueLiteral", () => {
    // Defence in depth: even if a caller hands a parsed intent whose
    // newValueLiteral bypassed the parser gate, the assembler re-validates and
    // refuses to splice unsafe text into source.
    const outcome = runDraft({
      parsed: parsedUpdate({ newValueLiteral: "20000; DROP TABLE rules" }),
      rule: codeRuleWithPatchTarget(),
    });
    expect(outcome.kind).toBe("proposal_draft");
    if (outcome.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    expect(outcome.sourcePatch).toBeUndefined();
    expect(outcome.proposal.diff.sourcePatch).toBeUndefined();
  });

  it("builds NO sourcePatch when the rule declared no patchTarget", () => {
    const outcome = runDraft({
      parsed: parsedUpdate({ newValueLiteral: "20000" }),
      rule: codeRuleWithPatchTarget({ patchTarget: undefined }),
    });
    expect(outcome.kind).toBe("proposal_draft");
    if (outcome.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    expect(outcome.sourcePatch).toBeUndefined();
    expect(outcome.proposal.diff.sourcePatch).toBeUndefined();
  });

  it("builds NO sourcePatch for a declarative (non-code) rule", () => {
    // A declarative rule takes the rebuild path, never the sourcePatch path —
    // even if it (nonsensically) carried a patchTarget and a newValueLiteral.
    const declarativeRule: SchemaIntentRule = {
      name: "warn_large_amount",
      label: "Warn on large amount",
      triggerActions: ["approve_purchase_request"],
      effectType: "warn",
      conditionKind: "declarative",
      condition: { field: "amount", operator: "gt", value: 5000 },
      roundTrippable: true,
      effect: { type: "warn", message: "Amount exceeds 5000" },
      patchTarget: { sourcePath: DEMO_PATCH_PATH, constantName: "MANAGER_APPROVAL_THRESHOLD" },
    };
    const outcome = runDraft({
      parsed: parsedUpdate({
        ruleName: "warn_large_amount",
        newValueLiteral: "20000",
        // A full declarative rule the rebuild path accepts.
        rule: {
          name: "warn_large_amount",
          label: "Warn on large amount",
          trigger: { action: "approve_purchase_request" },
          condition: { field: "amount", operator: "gt", value: 20000 },
          effect: { type: "warn", message: "Amount exceeds 20000" },
        },
      }),
      rule: declarativeRule,
    });
    expect(outcome.kind).toBe("proposal_draft");
    if (outcome.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    // Declarative rebuild path → a definition, never a sourcePatch.
    expect(outcome.sourcePatch).toBeUndefined();
    expect(outcome.proposal.diff.sourcePatch).toBeUndefined();
    expect(outcome.proposal.diff.definition).toBeDefined();
    expect(outcome.requiresCodeChange).toBeUndefined();
  });
});
