/**
 * Tests for ProposalFileWriter (Spec 55 §7.6 graduation).
 *
 * Verifies the writer materialises approved Proposals as TypeScript source
 * files under the target capability's tree, and that the ProposalEngine's
 * onApproved hook fires correctly without rolling back on persistence errors.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// `ai`-side proposal engine + the resolver's update-draft path: used by the
// full #566 assembly→graduation loop test below. Imported directly (not via the
// public barrel) because `draftRuleUpdate` is an internal resolver helper.
import { ProposalEngine as AiProposalEngine } from "../src/ai/proposal-engine";
import { draftRuleUpdate } from "../src/ai/schema-intent-rule-updater";
import type { SchemaIntentEntity } from "../src/ai/schema-intent-types";
import { createProposalEngine, ProposalFileWriter } from "../src/server-entry";
import type { ProposalChange, ProposalDefinition } from "../src/types/proposal";
import type { SourcePatchRequest, SourcePatchResult } from "../src/types/source-patch";

// ── Fixtures ────────────────────────────────────────────────

/**
 * Fixed UTC date used in every fixture so the date stamp segment of the
 * generated filename (`YYYYMMDD`) is deterministic in CI and on any machine.
 */
const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");
const FIXED_DATE_STAMP = "20260519";

/** Short-id derived from "proposal_test_001" → last 8 chars = "test_001". */
const TEST_SHORT_ID = "test_001";
/** Slug derived from "Auto-approve small orders". */
const TEST_TITLE_SLUG = "auto-approve-small-orders";
/** Full filename prefix used by makeApprovedProposal()'s default fixture. */
const TEST_PREFIX = `_${FIXED_DATE_STAMP}__${TEST_TITLE_SLUG}__${TEST_SHORT_ID}`;

/**
 * Build the same `YYYYMMDD` stamp the writer uses for fallbacks. UTC, zero-padded.
 * Shared by every "today UTC fallback" assertion so the formula lives in one place.
 */
function todayUtcDateStamp(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function makeApprovedProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const ruleChange: ProposalChange = {
    target: "rule",
    operation: "create",
    name: "auto_approve_small_orders",
    // A complete DECLARATIVE rule definition (trigger + data condition + effect).
    // The writer's graduatability guard refuses a rule definition missing any of
    // those three (it would otherwise graduate as a corrupt `defineRule({name})`
    // stub — #566), so every rule fixture carries a faithfully-serialisable shape.
    definition: {
      name: "auto_approve_small_orders",
      label: "Auto-approve small orders",
      trigger: { action: "submit_order" },
      condition: { field: "amount", operator: "lt", value: 100 },
      effect: { type: "enrich", setFields: { status: "approved" } },
    } as never, // RuleDefinition shape varies; cast to keep test fixture compact.
    diff: "Auto-approve orders under $100.",
  };

  return {
    id: "proposal_test_001",
    title: "Auto-approve small orders",
    description: "Generated from insight #42.",
    author: { type: "ai", id: "insight-translator", name: "Insight Translator" },
    capability: "cap-life-demo",
    changeType: "minor",
    changes: [ruleChange],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: ["auto_approve_small_orders"],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "approved",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    approvedAt: FIXED_NOW,
    approvedBy: { type: "human", id: "admin-1" },
    ...overrides,
  };
}

/**
 * A complete declarative rule change — trigger + data condition + effect — so
 * the writer's graduatability guard (#566) accepts it. Use this anywhere a test
 * needs a real, faithfully-serialisable rule (not the code-condition draft that
 * the guard intentionally refuses).
 */
function declarativeRuleChange(
  name: string,
  operation: ProposalChange["operation"] = "create",
): ProposalChange {
  return {
    target: "rule",
    operation,
    name,
    definition: {
      name,
      label: name,
      trigger: { action: "submit_order" },
      condition: { field: "amount", operator: "lt", value: 100 },
      effect: { type: "enrich", setFields: { status: "approved" } },
    } as never,
  };
}

function viewChange(name = "order_kanban"): ProposalChange {
  return {
    target: "view",
    operation: "create",
    name,
    definition: {
      name,
      entity: "order",
      type: "list",
      label: "Order Kanban",
      fields: [{ field: "title" }, { field: "status" }],
    },
  };
}

// ── Setup / teardown ────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "proposal-writer-"));
  // Pre-create the cap layout so the default pathResolver picks the right group.
  await mkdir(join(tmpDir, "addons", "demo", "cap-life-demo", "src"), { recursive: true });
});

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests ───────────────────────────────────────────────────

describe("ProposalFileWriter.writeApprovedProposal", () => {
  it("writes a rule change to the expected path", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal();

    const written = await writer.writeApprovedProposal(proposal);

    const expected = join(
      tmpDir,
      "addons",
      "demo",
      "cap-life-demo",
      "src",
      "rules",
      `${TEST_PREFIX}.auto_approve_small_orders.rule.ts`,
    );
    expect(written).toEqual([expected]);
    expect(existsSync(expected)).toBe(true);

    const contents = await readFile(expected, "utf8");
    expect(contents).toContain("defineRule(");
    expect(contents).toContain('"name": "auto_approve_small_orders"');
    // Header comment carries provenance.
    expect(contents).toContain(`Sourced from Proposal: ${proposal.id}`);
    expect(contents).toContain("Capability:");
  });

  it("writes a relation change to the relations/ subdir as defineRelation (#580)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const relationChange: ProposalChange = {
      target: "relation",
      operation: "create",
      name: "purchase_request_items",
      definition: {
        name: "purchase_request_items",
        from: "purchase_request",
        to: "purchase_item",
        cardinality: "one_to_many",
        fromName: "line_items",
        toName: "purchase_request",
      },
    };
    const proposal = makeApprovedProposal({ changes: [relationChange] });

    const written = await writer.writeApprovedProposal(proposal);

    const expected = join(
      tmpDir,
      "addons",
      "demo",
      "cap-life-demo",
      "src",
      "relations",
      `${TEST_PREFIX}.purchase_request_items.relation.ts`,
    );
    expect(written).toEqual([expected]);
    expect(existsSync(expected)).toBe(true);

    const contents = await readFile(expected, "utf8");
    expect(contents).toContain('import { defineRelation } from "@linchkit/core";');
    expect(contents).toContain("export default defineRelation(");
    expect(contents).toContain('"name": "purchase_request_items"');
    expect(contents).toContain('"from": "purchase_request"');
    expect(contents).toContain('"to": "purchase_item"');
    expect(contents).toContain('"cardinality": "one_to_many"');
  });

  it("writes AI-materialized generatedSource verbatim, not the codegen output (G5)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const GENERATED = [
      'import { defineAction } from "@linchkit/core";',
      "export const do_thing = defineAction({",
      '  name: "do_thing",',
      "  handler: async () => ({ ok: true }),",
      "});",
      "",
    ].join("\n");
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "action",
          operation: "create",
          name: "do_thing",
          definition: { name: "do_thing" } as never,
          generatedSource: GENERATED,
        },
      ],
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    expect(written).toBeDefined();
    const contents = await readFile(written as string, "utf8");
    // The materialized handler body lands verbatim — the deterministic codegen
    // (which would only scaffold a declarative wrapper) is NOT used.
    expect(contents).toBe(GENERATED);
    expect(contents).toContain("handler: async () => ({ ok: true })");
  });

  it("falls back to codegen for an empty generatedSource (never writes a blank file)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "action",
          operation: "create",
          name: "do_thing",
          definition: { name: "do_thing" } as never,
          generatedSource: "   \n", // whitespace-only → treated as absent
        },
      ],
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    const contents = await readFile(written as string, "utf8");
    expect(contents.trim().length).toBeGreaterThan(0); // not blank
    expect(contents).toContain("defineAction("); // deterministic scaffold used
  });

  it("writes multiple changes in one proposal", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [
        // First change: a rule
        declarativeRuleChange("auto_approve_small_orders"),
        // Second change: a view
        viewChange(),
      ],
    });

    const written = await writer.writeApprovedProposal(proposal);

    expect(written).toHaveLength(2);
    expect(written[0]).toContain("/rules/");
    expect(written[1]).toContain("/views/");
    for (const path of written) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it("writes two changes of the same target kind to distinct files (no collision)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [declarativeRuleChange("rule_one"), declarativeRuleChange("rule_two")],
    });

    const written = await writer.writeApprovedProposal(proposal);

    expect(written).toHaveLength(2);
    // Distinct paths — the change name must disambiguate.
    expect(new Set(written).size).toBe(2);
    expect(written[0]).toContain("rule_one");
    expect(written[1]).toContain("rule_two");
    // Both files actually written, neither was clobbered by the other.
    for (const p of written) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it("refuses to overwrite on create operation", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal();

    // Pre-create the target file.
    const target = join(
      tmpDir,
      "addons",
      "demo",
      "cap-life-demo",
      "src",
      "rules",
      `${TEST_PREFIX}.auto_approve_small_orders.rule.ts`,
    );
    await mkdir(join(tmpDir, "addons", "demo", "cap-life-demo", "src", "rules"), {
      recursive: true,
    });
    await writeFile(target, "// pre-existing", "utf8");

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/refusing to overwrite/);
    // Original file untouched.
    const contents = await readFile(target, "utf8");
    expect(contents).toBe("// pre-existing");
  });

  it("allows overwrite on update operation", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "rule",
          operation: "update",
          name: "auto_approve_small_orders",
          // A full declarative update (trigger + data condition + effect) — the
          // graduatability guard accepts it and the `w` flag overwrites the stale
          // file. `updated` is an extra marker the assertion below pins on.
          definition: {
            name: "auto_approve_small_orders",
            label: "Auto-approve small orders",
            trigger: { action: "submit_order" },
            condition: { field: "amount", operator: "lt", value: 100 },
            effect: { type: "enrich", setFields: { status: "approved" } },
            updated: true,
          } as never,
        },
      ],
    });

    const target = join(
      tmpDir,
      "addons",
      "demo",
      "cap-life-demo",
      "src",
      "rules",
      `${TEST_PREFIX}.auto_approve_small_orders.rule.ts`,
    );
    await mkdir(join(tmpDir, "addons", "demo", "cap-life-demo", "src", "rules"), {
      recursive: true,
    });
    await writeFile(target, "// stale", "utf8");

    const written = await writer.writeApprovedProposal(proposal);
    expect(written).toEqual([target]);

    const contents = await readFile(target, "utf8");
    expect(contents).not.toBe("// stale");
    expect(contents).toContain('"updated": true');
  });

  // ── Graduatability guard (#566 — silent-corruption hole) ──────────────────
  //
  // A code-condition rule update is the canonical un-serialisable case: the NL
  // resolver (schema-intent-rule-updater) honestly refuses to fabricate a
  // definition (`requiresCodeChange: true`, no `definition`). Without the guard,
  // the writer's `?? { name: change.name }` fallback graduated a corrupt
  // `defineRule({ "name": "…" })` stub — missing trigger/condition/effect. The
  // guard now FAILS LOUD instead of writing that stub. The full AI materializer
  // (which regenerates the condition function → `generatedSource`) is a separate
  // follow-up.

  it("THROWS on a code-condition rule update with no definition and no generatedSource (#566)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    // The honest code-condition draft: an `update` with NO definition (the
    // resolver intentionally left it undefined) and NO materialized source.
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "rule",
          operation: "update",
          name: "manager_approval_threshold",
          diff: "把经理审批阈值改成 2 万",
          // No `definition`, no `generatedSource`.
        },
      ],
    });

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(
      /manager_approval_threshold/,
    );
    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(
      /materialization|generatedSource/i,
    );

    // No corrupt stub was written.
    const rulesDir = join(tmpDir, "addons", "demo", "cap-life-demo", "src", "rules");
    expect(existsSync(rulesDir)).toBe(false);
  });

  it("THROWS on a rule update whose condition is a function (JSON.stringify would drop it) (#566)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    // A definition that LOOKS complete but carries a function condition — the
    // deterministic codegen (`JSON.stringify`) would silently drop it, emitting
    // a rule with `condition` lost. The guard refuses rather than corrupt.
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "rule",
          operation: "update",
          name: "manager_approval_threshold",
          definition: {
            name: "manager_approval_threshold",
            label: "Manager approval threshold",
            trigger: { action: "submit_request" },
            // Code condition — a real function, not declarative data.
            condition: (ctx: { target: Record<string, unknown> }) =>
              Number(ctx.target.amount) > 10000,
            effect: { type: "require_approval", level: "manager" },
          } as never,
        },
      ],
    });

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/function/i);
    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(
      /manager_approval_threshold/,
    );

    // Nothing written.
    const rulesDir = join(tmpDir, "addons", "demo", "cap-life-demo", "src", "rules");
    expect(existsSync(rulesDir)).toBe(false);
  });

  it("guard message is operation-aware — says 'create', not 'update', on a create (#587)", async () => {
    // The guard fires on create too (a brand-new rule with a function condition).
    // The hint message must reflect the actual operation, not hardcode "update"
    // (claude review on #587).
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "rule",
          operation: "create",
          name: "brand_new_code_rule",
          // No definition → default guard rejects; the message must say "create".
        },
      ],
    });

    // The message reads "…code-condition create needs…" — operation-accurate,
    // and therefore free of the misleading hardcoded "update".
    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/code-condition create/);
  });

  it("writes generatedSource verbatim for a code-condition rule update (guard skipped) (#566)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const GENERATED = [
      'import { defineRule } from "@linchkit/core";',
      "export default defineRule({",
      '  name: "manager_approval_threshold",',
      '  label: "Manager approval threshold",',
      '  trigger: { action: "submit_request" },',
      "  condition: (ctx) => Number(ctx.target.amount) > 20000,",
      '  effect: { type: "require_approval", level: "manager" },',
      "});",
      "",
    ].join("\n");
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "rule",
          operation: "update",
          name: "manager_approval_threshold",
          // Materialized source present → trusted, written verbatim, no guard.
          generatedSource: GENERATED,
        },
      ],
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    expect(written).toBeDefined();
    const contents = await readFile(written as string, "utf8");
    expect(contents).toBe(GENERATED);
    expect(contents).toContain("condition: (ctx) => Number(ctx.target.amount) > 20000");
  });

  it("writes a valid defineRule file for a full declarative rule update (no regression) (#566)", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [declarativeRuleChange("auto_approve_small_orders", "update")],
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    const contents = await readFile(written as string, "utf8");
    // Valid defineRule(...) source with the declarative condition serialised.
    expect(contents).toContain("export default defineRule(");
    expect(contents).toContain('"trigger"');
    expect(contents).toContain('"condition"');
    expect(contents).toContain('"effect"');
    expect(contents).toContain('"operator": "lt"');
  });

  it("does NOT apply the guard when a custom codegen is supplied (escape hatch) (#566)", async () => {
    // A caller-supplied `codegen` is the escape hatch for unusual ChangeDefinition
    // shapes — it may legitimately handle a code-condition / definition-less rule
    // update itself. The graduatability guard encodes `defaultCodegen`'s limits
    // only, so it must NOT pre-empt a custom generator (gemini review on #587).
    const CUSTOM = "// custom generator output\nexport default {/* hand-rolled */};\n";
    let sawChange = false;
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      codegen: () => {
        sawChange = true;
        return CUSTOM;
      },
    });
    const proposal = makeApprovedProposal({
      changes: [
        {
          target: "rule",
          operation: "update",
          name: "manager_approval_threshold",
          // The shape the default guard rejects (no definition, no generatedSource)
          // — but the custom codegen owns it, so no throw.
          diff: "把经理审批阈值改成 2 万",
        },
      ],
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    expect(sawChange).toBe(true);
    const contents = await readFile(written as string, "utf8");
    expect(contents).toBe(CUSTOM);
  });

  it("throws when proposal is not approved", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const draft = makeApprovedProposal({ status: "draft" });

    await expect(writer.writeApprovedProposal(draft)).rejects.toThrow(/requires status "approved"/);
  });

  it("falls back to <short> directory when group cannot be inferred", async () => {
    // Use a fresh tmpdir that does NOT have the expected addons layout.
    const isolatedRoot = await mkdtemp(join(tmpdir(), "proposal-writer-isolated-"));
    try {
      const writer = new ProposalFileWriter({ rootDir: isolatedRoot });
      const proposal = makeApprovedProposal({ capability: "cap-unknown" });
      const written = await writer.writeApprovedProposal(proposal);
      // Default fallback: addons/<short>/cap-<full>/src/rules/...
      expect(written[0]).toContain(
        join(
          "addons",
          "unknown",
          "cap-unknown",
          "src",
          "rules",
          `${TEST_PREFIX}.auto_approve_small_orders.rule.ts`,
        ),
      );
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});

// ── Filename format ─────────────────────────────────────────

describe("ProposalFileWriter filename format", () => {
  it("includes YYYYMMDD date, slugified title and short-id", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal();

    const [written] = await writer.writeApprovedProposal(proposal);

    // Path basename should match `_YYYYMMDD__<slug>__<short-id>.<change>.<kind>.ts`.
    const basename = written.split("/").pop() ?? "";
    expect(basename).toBe(`${TEST_PREFIX}.auto_approve_small_orders.rule.ts`);
    expect(basename).toContain(FIXED_DATE_STAMP);
    expect(basename).toContain(TEST_TITLE_SLUG);
    expect(basename).toContain(TEST_SHORT_ID);
  });

  it("collapses empty title slug into single __ separator", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({ title: "" });

    const [written] = await writer.writeApprovedProposal(proposal);

    const basename = written.split("/").pop() ?? "";
    // No slug → `_YYYYMMDD__<short-id>.<change>.<kind>.ts` (single `__`).
    expect(basename).toBe(
      `_${FIXED_DATE_STAMP}__${TEST_SHORT_ID}.auto_approve_small_orders.rule.ts`,
    );
    // Defensive: must not contain `____` (4 underscores in a row).
    expect(basename).not.toContain("____");
  });

  it("collapses special-char-only title slug into single __ separator", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({ title: "!!!???" });

    const [written] = await writer.writeApprovedProposal(proposal);

    const basename = written.split("/").pop() ?? "";
    expect(basename).toBe(
      `_${FIXED_DATE_STAMP}__${TEST_SHORT_ID}.auto_approve_small_orders.rule.ts`,
    );
    expect(basename).not.toContain("____");
  });

  it("truncates long titles to <= 40 chars and trims trailing dashes", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    // 41st character lands on the boundary so the slice produces a trailing `-`
    // that the implementation must strip.
    const proposal = makeApprovedProposal({
      title: `${"a".repeat(40)} ${"b".repeat(20)}`,
    });

    const [written] = await writer.writeApprovedProposal(proposal);

    const basename = written.split("/").pop() ?? "";
    // Slug must be exactly 40 chars of "a" — the boundary `-` is trimmed.
    const expectedSlug = "a".repeat(40);
    expect(basename).toBe(
      `_${FIXED_DATE_STAMP}__${expectedSlug}__${TEST_SHORT_ID}.auto_approve_small_orders.rule.ts`,
    );
    // No "-." artefact from a leftover trailing dash.
    expect(basename).not.toContain("-_");
    expect(basename).not.toContain("-.");
  });

  it("disambiguates same-title proposals via short-id", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const a = makeApprovedProposal({ id: "proposal_aaaaaaaa" });
    const b = makeApprovedProposal({ id: "proposal_bbbbbbbb" });

    const [pathA] = await writer.writeApprovedProposal(a);
    const [pathB] = await writer.writeApprovedProposal(b);

    expect(pathA).not.toBe(pathB);
    expect(pathA.split("/").pop()).toContain("aaaaaaaa");
    expect(pathB.split("/").pop()).toContain("bbbbbbbb");
  });

  it("uses today UTC when createdAt is missing", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      // Cast: createdAt is required in the type, but we want to exercise the
      // missing-date fallback path defensively.
      createdAt: undefined as unknown as Date,
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    expect(written.split("/").pop()).toContain(todayUtcDateStamp());
  });

  it("parses string createdAt values", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      createdAt: "2025-01-15T08:30:00.000Z" as unknown as Date,
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    expect(written.split("/").pop()).toContain("20250115");
  });

  it("falls back to today UTC for unparseable createdAt strings", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      createdAt: "not-a-date" as unknown as Date,
    });

    const [written] = await writer.writeApprovedProposal(proposal);
    expect(written.split("/").pop()).toContain(todayUtcDateStamp());
  });

  it("uses entire id when shorter than 8 chars", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({ id: "abc" });

    const [written] = await writer.writeApprovedProposal(proposal);

    const basename = written.split("/").pop() ?? "";
    // Short-id segment is the whole id ("abc"), preceded by `__`.
    expect(basename).toBe(
      `_${FIXED_DATE_STAMP}__${TEST_TITLE_SLUG}__abc.auto_approve_small_orders.rule.ts`,
    );
  });
});

// ── Formatter option ────────────────────────────────────────

describe("ProposalFileWriter formatter option", () => {
  it("default (no formatter) is byte-identical to raw codegen output", async () => {
    const raw = new ProposalFileWriter({ rootDir: tmpDir });
    const [rawPath] = await raw.writeApprovedProposal(makeApprovedProposal());
    const rawContents = await readFile(rawPath, "utf8");

    // Recreate the layout for the second writer in a sibling tmpdir so the
    // pre-existing file does not cause an EEXIST.
    const otherTmp = await mkdtemp(join(tmpdir(), "proposal-writer-noop-"));
    try {
      await mkdir(join(otherTmp, "addons", "demo", "cap-life-demo", "src"), { recursive: true });
      const noop = new ProposalFileWriter({ rootDir: otherTmp, formatter: undefined });
      const [noopPath] = await noop.writeApprovedProposal(makeApprovedProposal());
      const noopContents = await readFile(noopPath, "utf8");
      // Header timestamp differs per call; compare everything after it. We
      // strip the header (delimited by the trailing `*/\n`) so the rest must
      // match exactly.
      const stripHeader = (s: string) => s.slice(s.indexOf("*/\n") + 3);
      expect(stripHeader(noopContents)).toBe(stripHeader(rawContents));
    } finally {
      await rm(otherTmp, { recursive: true, force: true });
    }
  });

  it("invokes a custom formatter with (source, filename) and writes its return value", async () => {
    const calls: Array<{ source: string; filename: string }> = [];
    const formatter = async (source: string, filename: string) => {
      calls.push({ source, filename });
      return `// CUSTOM FORMATTED\n${source}// EOF\n`;
    };

    const writer = new ProposalFileWriter({ rootDir: tmpDir, formatter });
    const [written] = await writer.writeApprovedProposal(makeApprovedProposal());

    expect(calls).toHaveLength(1);
    expect(calls[0].filename).toBe(written);
    expect(calls[0].source).toContain("defineRule(");

    const contents = await readFile(written, "utf8");
    expect(contents.startsWith("// CUSTOM FORMATTED\n")).toBe(true);
    expect(contents.endsWith("// EOF\n")).toBe(true);
  });

  it("transforms output when formatter changes the source", async () => {
    // Hand-rolled formatter that strips redundant blank lines and guarantees
    // a single trailing newline — emulating Biome's normalisation. We then
    // assert the on-disk file looks normalised, even though the raw codegen
    // happens to be well-formed already.
    const formatter = async (source: string) => {
      const collapsed = source.replace(/\n{3,}/g, "\n\n");
      return collapsed.endsWith("\n") ? collapsed : `${collapsed}\n`;
    };

    // Wrap codegen to inject extra blank lines so the formatter has work to do.
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      codegen: (proposal, change) => {
        return `export const x = 1;\n\n\n\n\nexport const y = 2;\n// proposal ${proposal.id}/${change.name}`;
      },
      formatter,
    });
    const [written] = await writer.writeApprovedProposal(makeApprovedProposal());
    const contents = await readFile(written, "utf8");

    // Collapsed blank lines, trailing newline appended.
    expect(contents).not.toContain("\n\n\n");
    expect(contents.endsWith("\n")).toBe(true);
  });

  it("swallows formatter errors and writes the raw source", async () => {
    const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, context?: Record<string, unknown>) => {
        logs.push({ message, context });
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        logs.push({ message, context });
      },
    };
    const formatter = async () => {
      throw new Error("boom");
    };

    const writer = new ProposalFileWriter({ rootDir: tmpDir, formatter, logger });
    const [written] = await writer.writeApprovedProposal(makeApprovedProposal());

    const contents = await readFile(written, "utf8");
    // Raw codegen output is preserved (header + defineRule wrapper).
    expect(contents).toContain("defineRule(");
    expect(contents).toContain("AUTO-GENERATED by ProposalFileWriter");

    // Warning emitted with the failure reason.
    const warning = logs.find((l) => l.message.includes("formatter failed"));
    expect(warning).toBeDefined();
    expect(warning?.context?.error).toBe("boom");
  });

  it("default Biome formatter (formatter: true) is wired and either formats or falls back", async () => {
    // We do NOT assume `bunx @biomejs/biome` is reachable in every CI shard —
    // a non-zero exit must be swallowed and the raw source still written.
    const writer = new ProposalFileWriter({ rootDir: tmpDir, formatter: true });
    const [written] = await writer.writeApprovedProposal(makeApprovedProposal());

    const contents = await readFile(written, "utf8");
    // Whether Biome ran or not, the file must exist with valid generated code.
    expect(contents).toContain("defineRule(");
  });

  it('skips a target:"revert" change (no file written) and warns (Spec 55 §7.7)', async () => {
    const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, context?: Record<string, unknown>) => {
        logs.push({ message, context });
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        logs.push({ message, context });
      },
    };

    const revertChange: ProposalChange = {
      target: "revert",
      operation: "update",
      // Fixed, validation-safe name produced by rollbackCandidateTranslator; the
      // proposalId being reverted is carried in `diff`, not in `name`.
      name: "revert",
      diff: 'Roll back merged proposal "proposal_abc".',
    };

    const writer = new ProposalFileWriter({ rootDir: tmpDir, logger });
    const proposal = makeApprovedProposal({ changes: [revertChange] });

    const written = await writer.writeApprovedProposal(proposal);

    // Nothing was written for a revert change — it has no source file.
    expect(written).toEqual([]);

    const warning = logs.find((l) => l.message.includes("skipping revert change"));
    expect(warning).toBeDefined();
    expect(warning?.context?.target).toBe("revert");
    expect(warning?.context?.name).toBe("revert");
  });
});

/** A self-contained entity create — passes Phase 1 validation without registry. */
function selfContainedEntityChange(name = "widget"): ProposalChange {
  return {
    target: "entity",
    operation: "create",
    name,
    definition: {
      name,
      label: "Widget",
      fields: {
        title: { type: "string", required: true, default: "", label: "Title" },
      },
    } as never,
  };
}

// ── In-place source patch (#566 — Option A capability-seam) ──────────────────
//
// A `sourcePatch` change graduates by patching a NAMED CONSTANT in an EXISTING
// source file IN PLACE — a THIRD path alongside declarative codegen and
// AI-materialized generatedSource. The concrete TS-AST patcher lives OUTSIDE
// core and is INJECTED via `sourcePatcher`; these tests use a tiny fake.

describe("ProposalFileWriter source patch (#566)", () => {
  /**
   * A tiny fake patcher: records the request it received and replaces
   * `<constantName> = 10000` with `<constantName> = <newValueLiteral>`. Stands
   * in for the real injected TS-AST `patchNamedConstant` (which lives outside
   * core).
   */
  function makeFakePatcher() {
    const calls: SourcePatchRequest[] = [];
    const patcher = (request: SourcePatchRequest): SourcePatchResult => {
      calls.push(request);
      const needle = `${request.constantName} = 10000`;
      const replacement = `${request.constantName} = ${request.newValueLiteral}`;
      return {
        source: request.source.replace(needle, replacement),
        oldValueLiteral: "10000",
        changed: request.source.includes(needle),
      };
    };
    return { calls, patcher };
  }

  function sourcePatchProposal(
    filePath: string,
    overrides: Partial<NonNullable<ProposalChange["sourcePatch"]>> = {},
  ): ProposalDefinition {
    const change: ProposalChange = {
      target: "rule",
      operation: "update",
      name: "manager_approval_threshold",
      diff: "把经理审批阈值改成 2 万",
      sourcePatch: {
        filePath,
        constantName: "MANAGER_APPROVAL_THRESHOLD",
        newValueLiteral: "20000",
        ...overrides,
      },
    };
    return makeApprovedProposal({ changes: [change] });
  }

  it("patches the existing file IN PLACE via the injected patcher", async () => {
    // Existing source file with a named constant to patch.
    const relPath = join("rules", "x.ts");
    const absPath = join(tmpDir, relPath);
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    await writeFile(absPath, "export const MANAGER_APPROVAL_THRESHOLD = 10000;\n", "utf8");

    const { calls, patcher } = makeFakePatcher();
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      repoRoot: tmpDir,
      sourcePatcher: patcher,
    });

    const written = await writer.writeApprovedProposal(sourcePatchProposal(relPath));

    // The returned written[] carries the absolute path of the patched file.
    expect(written).toEqual([absPath]);

    // File content was replaced in place with the patcher's output.
    const contents = await readFile(absPath, "utf8");
    expect(contents).toBe("export const MANAGER_APPROVAL_THRESHOLD = 20000;\n");

    // The patcher received the right request.
    expect(calls).toHaveLength(1);
    expect(calls[0].constantName).toBe("MANAGER_APPROVAL_THRESHOLD");
    expect(calls[0].newValueLiteral).toBe("20000");
    expect(calls[0].source).toContain("= 10000");
  });

  it("graduates the sourcePatch ASSEMBLED by draftRuleUpdate (full #566 loop)", async () => {
    // End-to-end seam: the sourcePatch the resolver's draftRuleUpdate assembles
    // for the demo manager-approval rule drives the writer to rewrite the real
    // MANAGER_APPROVAL_THRESHOLD constant via the injected fake patcher. This
    // proves the two halves (assembly + graduation) compose without the runtime
    // TS-AST patcher (that injection is a separate follow-up PR).
    const entity: SchemaIntentEntity = {
      name: "purchase_request",
      label: "Purchase Request",
      fields: [{ name: "amount", type: "number", required: true }],
      actionNames: ["approve_purchase_request"],
      rules: [
        {
          name: "manager_approval_threshold",
          label: "Manager approval threshold",
          triggerActions: ["approve_purchase_request"],
          effectType: "block",
          conditionKind: "code",
          patchTarget: {
            // Patch the file we create under tmpDir below (relative to repoRoot).
            sourcePath: join("rules", "manager-approval-threshold.ts"),
            constantName: "MANAGER_APPROVAL_THRESHOLD",
          },
        },
      ],
    };
    const drafted = draftRuleUpdate({
      parsed: {
        kind: "update_rule",
        targetEntity: "purchase_request",
        ruleName: "manager_approval_threshold",
        diff: "Raise the manager-approval threshold to 20000.",
        newValueLiteral: "20000",
        confidence: 0.9,
        explanation: "把经理审批阈值改成2万。",
      },
      entity,
      confidence: 0.9,
      utterance: "把经理审批阈值改成2万",
      engine: new AiProposalEngine(),
    });
    expect(drafted.kind).toBe("proposal_draft");
    if (drafted.kind !== "proposal_draft") throw new Error("expected proposal_draft");
    const assembled = drafted.sourcePatch;
    expect(assembled).toBeDefined();
    if (!assembled) throw new Error("expected an assembled sourcePatch");

    // Create the on-disk file the patch targets.
    const absPath = join(tmpDir, assembled.filePath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, "export const MANAGER_APPROVAL_THRESHOLD = 10000;\n", "utf8");

    // Build a governed proposal whose single change carries the ASSEMBLED patch.
    const change: ProposalChange = {
      target: "rule",
      operation: "update",
      name: "manager_approval_threshold",
      diff: "Raise the manager-approval threshold to 20000.",
      sourcePatch: assembled,
    };
    const { calls, patcher } = makeFakePatcher();
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      repoRoot: tmpDir,
      sourcePatcher: patcher,
    });

    const written = await writer.writeApprovedProposal(makeApprovedProposal({ changes: [change] }));

    expect(written).toEqual([absPath]);
    expect(await readFile(absPath, "utf8")).toBe(
      "export const MANAGER_APPROVAL_THRESHOLD = 20000;\n",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].constantName).toBe("MANAGER_APPROVAL_THRESHOLD");
    expect(calls[0].newValueLiteral).toBe("20000");
  });

  it("does NOT rewrite the file when the patch is a no-op (changed: false) (gemini #590)", async () => {
    // The value is already at target → the patcher reports changed: false.
    // Rewriting identical bytes would bump mtime and trip watchers/HMR, so the
    // writer must SKIP the write. To prove it, the fake patcher reports no change
    // but returns DIFFERENT bytes: if the writer wrote unconditionally the file
    // would become the marker; skipping on changed:false keeps the original.
    const relPath = join("rules", "noop.ts");
    const absPath = join(tmpDir, relPath);
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    const ORIGINAL = "export const MANAGER_APPROVAL_THRESHOLD = 20000;\n";
    await writeFile(absPath, ORIGINAL, "utf8");

    const patcher = (): SourcePatchResult => ({
      source: "// MARKER — must never be written on a no-op\n",
      oldValueLiteral: "20000",
      changed: false,
    });
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      repoRoot: tmpDir,
      sourcePatcher: patcher,
    });

    const written = await writer.writeApprovedProposal(sourcePatchProposal(relPath));

    // A no-op is NOT reported as written (claude #590)...
    expect(written).toEqual([]);
    // ...and the file was NOT rewritten — content is the original, not the marker.
    expect(await readFile(absPath, "utf8")).toBe(ORIGINAL);
  });

  it("THROWS when a sourcePatch change has no injected sourcePatcher (names proposal/change)", async () => {
    const relPath = join("rules", "x.ts");
    const absPath = join(tmpDir, relPath);
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    await writeFile(absPath, "export const MANAGER_APPROVAL_THRESHOLD = 10000;\n", "utf8");

    // No sourcePatcher injected.
    const writer = new ProposalFileWriter({ rootDir: tmpDir, repoRoot: tmpDir });
    const proposal = sourcePatchProposal(relPath);

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(
      /manager_approval_threshold/,
    );
    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/sourcePatcher|injected/i);

    // The file was left untouched (no patch applied).
    const contents = await readFile(absPath, "utf8");
    expect(contents).toBe("export const MANAGER_APPROVAL_THRESHOLD = 10000;\n");
  });

  it("THROWS on path traversal that escapes repoRoot, reading/writing nothing outside", async () => {
    const { calls, patcher } = makeFakePatcher();
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      repoRoot: tmpDir,
      sourcePatcher: patcher,
    });
    // An attempt to escape the repoRoot.
    const proposal = sourcePatchProposal("../../etc/evil.ts");

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/escapes repoRoot/);

    // Patcher never invoked — nothing was read or written outside the repo.
    expect(calls).toHaveLength(0);
  });

  it("rejects a symlink INSIDE repoRoot that resolves OUTSIDE it (coderabbit #590)", async () => {
    // A symlink whose own path is inside repoRoot but whose target is outside
    // must not be patchable — the string-level check passes, so only the realpath
    // containment catches it. Proves the symlink-escape defense.
    const outsideDir = await mkdtemp(join(tmpdir(), "sp-outside-"));
    const outsideFile = join(outsideDir, "secret.ts");
    const ORIGINAL = "export const MANAGER_APPROVAL_THRESHOLD = 10000;\n";
    await writeFile(outsideFile, ORIGINAL, "utf8");
    await mkdir(join(tmpDir, "rules"), { recursive: true });
    const linkRel = join("rules", "link.ts");
    await symlink(outsideFile, join(tmpDir, linkRel));

    try {
      const { calls, patcher } = makeFakePatcher();
      const writer = new ProposalFileWriter({
        rootDir: tmpDir,
        repoRoot: tmpDir,
        sourcePatcher: patcher,
      });

      await expect(writer.writeApprovedProposal(sourcePatchProposal(linkRel))).rejects.toThrow(
        /symlink|outside repoRoot/i,
      );

      // The outside target was neither patched nor even read.
      expect(calls).toHaveLength(0);
      expect(await readFile(outsideFile, "utf8")).toBe(ORIGINAL);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("THROWS when the sourcePatch target file is missing", async () => {
    const { calls, patcher } = makeFakePatcher();
    const writer = new ProposalFileWriter({
      rootDir: tmpDir,
      repoRoot: tmpDir,
      sourcePatcher: patcher,
    });
    // Points at a file that does not exist (inside the repo, so traversal passes).
    const proposal = sourcePatchProposal(join("rules", "does-not-exist.ts"));

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/does not exist|missing/i);

    // Patcher never invoked — the missing file is caught before patching.
    expect(calls).toHaveLength(0);
  });

  it("defaults repoRoot to process.cwd() when not supplied", async () => {
    // Resolve a path relative to cwd that escapes into an unrelated dir — the
    // default repoRoot (process.cwd()) is used, and a traversal still throws.
    const { patcher } = makeFakePatcher();
    const writer = new ProposalFileWriter({ rootDir: tmpDir, sourcePatcher: patcher });
    const proposal = sourcePatchProposal("../../../../etc/passwd.ts");

    await expect(writer.writeApprovedProposal(proposal)).rejects.toThrow(/escapes repoRoot/);
  });
});

describe("ProposalEngine.onApproved hook", () => {
  it("fires on approveProposal and persists the file", async () => {
    // Set up the cap layout for engine-driven test.
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const engine = createProposalEngine({
      onApproved: (p) => writer.writeApprovedProposal(p),
    });

    const proposal = engine.createProposal({
      title: "Add widget entity",
      description: "test",
      author: { type: "human", id: "user-1", name: "Alice" },
      capability: "cap-life-demo",
      changeType: "minor",
      changes: [selfContainedEntityChange("widget")],
    });

    const submitted = engine.submitProposal({ proposalId: proposal.id });
    expect(submitted.status).toBe("validated");

    await engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });

    // Locate the produced file by its stable suffix — the date/short-id
    // prefix is determined by engine-generated values we don't control here.
    const entitiesDir = join(tmpDir, "addons", "demo", "cap-life-demo", "src", "entities");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(entitiesDir);
    const target = files.find((f) => f.endsWith(".widget.entity.ts"));
    expect(target).toBeDefined();
    expect(existsSync(join(entitiesDir, target as string))).toBe(true);

    const stored = engine.getProposal(proposal.id);
    expect(stored.status).toBe("approved");
    expect(stored.persistenceError).toBeUndefined();
  });

  it("captures hook failures in persistenceError without rolling back approval", async () => {
    const engine = createProposalEngine({
      onApproved: () => {
        throw new Error("boom");
      },
    });

    const proposal = engine.createProposal({
      title: "Add widget entity",
      description: "test",
      author: { type: "human", id: "user-1", name: "Alice" },
      capability: "cap-life-demo",
      changeType: "minor",
      changes: [selfContainedEntityChange("gizmo")],
    });

    const submitted = engine.submitProposal({ proposalId: proposal.id });
    expect(submitted.status).toBe("validated");

    const approved = await engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });

    // Approval still stands.
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).toBeInstanceOf(Date);
    // But the persistence error is surfaced for the caller to handle.
    expect(approved.persistenceError).toBe("boom");

    // And the stored proposal reflects the same state.
    const stored = engine.getProposal(proposal.id);
    expect(stored.status).toBe("approved");
    expect(stored.persistenceError).toBe("boom");
  });
});
