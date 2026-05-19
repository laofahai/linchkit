/**
 * Tests for ProposalFileWriter (Spec 55 §7.6 graduation).
 *
 * Verifies the writer materialises approved Proposals as TypeScript source
 * files under the target capability's tree, and that the ProposalEngine's
 * onApproved hook fires correctly without rolling back on persistence errors.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProposalEngine, ProposalFileWriter } from "../src/server-entry";
import type { ProposalChange, ProposalDefinition } from "../src/types/proposal";

// ── Fixtures ────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-19T12:00:00.000Z");

function makeApprovedProposal(overrides: Partial<ProposalDefinition> = {}): ProposalDefinition {
  const ruleChange: ProposalChange = {
    target: "rule",
    operation: "create",
    name: "auto_approve_small_orders",
    definition: {
      name: "auto_approve_small_orders",
      trigger: { type: "manual" },
      effect: { type: "set_field", field: "status", value: "approved" },
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
      `_${proposal.id}.rule.ts`,
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

  it("writes multiple changes in one proposal", async () => {
    const writer = new ProposalFileWriter({ rootDir: tmpDir });
    const proposal = makeApprovedProposal({
      changes: [
        // First change: a rule
        {
          target: "rule",
          operation: "create",
          name: "auto_approve_small_orders",
          definition: { name: "auto_approve_small_orders" } as never,
        },
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
      `_${proposal.id}.rule.ts`,
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
          definition: { name: "auto_approve_small_orders", updated: true } as never,
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
      `_${proposal.id}.rule.ts`,
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
        join("addons", "unknown", "cap-unknown", "src", "rules", `_${proposal.id}.rule.ts`),
      );
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
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

    const expected = join(
      tmpDir,
      "addons",
      "demo",
      "cap-life-demo",
      "src",
      "entities",
      `_${proposal.id}.entity.ts`,
    );
    expect(existsSync(expected)).toBe(true);

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
