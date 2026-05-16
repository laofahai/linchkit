import { describe, expect, it } from "bun:test";
import {
  buildCompatibilitySnapshot,
  type CompatibilityRegistrySnapshot,
} from "../src/ai/proposal-compatibility-checker";
import { ProposalEngine } from "../src/ai/proposal-engine";
import {
  createExtendedProposalValidator,
  validateProposalExtended,
} from "../src/ai/proposal-validator-extended";
import type { EntityDefinition } from "../src/types/entity";

// ── Fixtures ──────────────────────────────────────────────────

function makeEntity(): EntityDefinition {
  return {
    name: "invoice",
    fields: {
      id: { type: "string", required: true },
      amount: { type: "number" },
      note: { type: "string" },
    },
  };
}

function makeSnapshot(): CompatibilityRegistrySnapshot {
  return buildCompatibilitySnapshot([makeEntity()], []);
}

// ── Pipeline composition ─────────────────────────────────────

describe("validateProposalExtended — pipeline composition", () => {
  it("runs all 4 phases when compatibility input is provided", () => {
    const snapshot = makeSnapshot();
    const result = validateProposalExtended({
      securityChanges: [{ type: "create_action", target: "submit_invoice" }],
      compatibilityChanges: [
        {
          kind: "field_add",
          entity: "invoice",
          field: "currency",
          definition: { type: "string" },
        },
      ],
      snapshot,
    });
    expect(result.passed).toBe(true);
    expect(result.phases.map((p) => p.name)).toEqual([
      "static",
      "build",
      "compatibility",
      "dry_run",
    ]);
    expect(result.phases.every((p) => p.status === "passed")).toBe(true);
    expect(result.compatibility).toBeDefined();
    expect(result.dryRun).toBeDefined();
  });

  it("skips Phase 3+4 when no compatibility input supplied", () => {
    const result = validateProposalExtended({
      securityChanges: [{ type: "create_action", target: "submit_invoice" }],
    });
    expect(result.passed).toBe(true);
    expect(result.phases[2].status).toBe("skipped");
    expect(result.phases[3].status).toBe("skipped");
    expect(result.compatibility).toBeUndefined();
    expect(result.dryRun).toBeUndefined();
  });

  it("fails the pipeline when Phase 3 reports breaking changes", () => {
    const snapshot = makeSnapshot();
    const result = validateProposalExtended({
      securityChanges: [{ type: "modify_schema", target: "invoice" }],
      compatibilityChanges: [
        {
          kind: "field_constraint_change",
          entity: "invoice",
          field: "note",
          patch: { required: true }, // nullable → required = breaking
        },
      ],
      snapshot,
    });
    expect(result.passed).toBe(false);
    expect(result.phases.find((p) => p.name === "compatibility")?.status).toBe("failed");
    expect(result.compatibility?.compatible).toBe(false);
  });

  it("fails the pipeline when Phase 4 reports model errors", () => {
    const snapshot = makeSnapshot();
    const result = validateProposalExtended({
      securityChanges: [{ type: "modify_schema", target: "invoice" }],
      compatibilityChanges: [{ kind: "field_drop", entity: "invoice", field: "ghost_field" }],
      snapshot,
    });
    expect(result.passed).toBe(false);
    expect(result.phases.find((p) => p.name === "dry_run")?.status).toBe("failed");
    expect(result.dryRun?.ok).toBe(false);
  });

  it("fails Phase 1+2 when security validation rejects the change", () => {
    const snapshot = makeSnapshot();
    const result = validateProposalExtended({
      securityChanges: [{ type: "delete_rule", target: "any_rule" }], // forbidden by default
      compatibilityChanges: [
        {
          kind: "field_add",
          entity: "invoice",
          field: "tags",
          definition: { type: "string" },
        },
      ],
      snapshot,
    });
    expect(result.passed).toBe(false);
    expect(result.phases.find((p) => p.name === "static")?.status).toBe("failed");
    expect(result.security.valid).toBe(false);
  });

  it("honours skipCompatibility / skipDryRun config flags", () => {
    const snapshot = makeSnapshot();
    const result = validateProposalExtended(
      {
        securityChanges: [{ type: "create_action", target: "x" }],
        compatibilityChanges: [
          {
            kind: "field_add",
            entity: "invoice",
            field: "tags",
            definition: { type: "string" },
          },
        ],
        snapshot,
      },
      { skipCompatibility: true, skipDryRun: true },
    );
    expect(result.phases.find((p) => p.name === "compatibility")?.status).toBe("skipped");
    expect(result.phases.find((p) => p.name === "dry_run")?.status).toBe("skipped");
  });
});

// ── createExtendedProposalValidator ───────────────────────────

describe("createExtendedProposalValidator", () => {
  it("creates a reusable validator preserving config", () => {
    const validator = createExtendedProposalValidator({
      security: { maxChangesPerProposal: 3 },
    });
    expect(validator.config.security?.maxChangesPerProposal).toBe(3);

    const result = validator.validate({
      securityChanges: [
        { type: "create_action", target: "a" },
        { type: "create_action", target: "b" },
        { type: "create_action", target: "c" },
        { type: "create_action", target: "d" }, // exceeds 3
      ],
    });
    expect(result.passed).toBe(false);
  });
});

// ── ProposalEngine.validateExtended ───────────────────────────

describe("ProposalEngine.validateExtended", () => {
  it("runs the full pipeline through the engine and returns combined report", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal({
      type: "modify_schema",
      description: "Add currency field",
      reasoning: "Multi-currency support",
      confidence: 0.9,
      diff: {
        target: "entity",
        operation: "update",
        definition: { entity: "invoice", name: "invoice" },
        summary: "Add currency",
      },
    });

    const snapshot = makeSnapshot();
    const result = engine.validateExtended(proposal.id, {
      compatibilityChanges: [
        {
          kind: "field_add",
          entity: "invoice",
          field: "currency",
          definition: { type: "string" },
        },
      ],
      snapshot,
    });

    expect(result.passed).toBe(true);
    expect(result.phases).toHaveLength(4);
    expect(result.compatibility).toBeDefined();
    expect(result.dryRun).toBeDefined();
    expect(result.dryRun?.sideEffects.fieldsAdded).toBe(1);
  });

  it("returns combined failure when Phase 3 detects a breaking change via the engine", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal({
      type: "modify_schema",
      description: "Drop note",
      reasoning: "Cleanup",
      confidence: 0.5,
      diff: {
        target: "entity",
        operation: "update",
        definition: { entity: "invoice", name: "invoice" },
        summary: "Drop note",
      },
    });

    const snapshot = buildCompatibilitySnapshot(
      [makeEntity()],
      [
        // someone references invoice.id
        {
          fromEntity: "invoice",
          fromField: "id",
          toEntity: "invoice",
          toField: "id",
        },
      ],
    );
    const result = engine.validateExtended(proposal.id, {
      compatibilityChanges: [{ kind: "field_drop", entity: "invoice", field: "id" }],
      snapshot,
    });

    expect(result.passed).toBe(false);
    expect(result.compatibility?.compatible).toBe(false);
    expect(result.compatibility?.breaking[0].rule).toBe("drop_field_with_references");
  });

  it("does not change proposal status when validateExtended is invoked", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal({
      type: "add_rule",
      description: "test",
      reasoning: "test",
      confidence: 0.9,
      diff: { target: "rule", operation: "create", summary: "x" },
    });
    engine.validateExtended(proposal.id);
    expect(engine.get(proposal.id)?.status).toBe("draft");
  });
});
