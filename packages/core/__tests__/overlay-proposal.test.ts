/**
 * Runtime Entity Overlay — Proposal integration tests
 *
 * Covers: overlay proposal creation, auto-approval evaluation,
 * proposal pipeline execution, and overlay store side effects.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  canAutoApproveOverlayChange,
  canAutoApproveOverlayProposal,
  executeOverlayProposal,
} from "../src/engine/overlay-proposal-executor";
import { type CreateProposalOptions, ProposalEngine } from "../src/engine/proposal-engine";
import { InMemoryOverlayStore } from "../src/persistence/in-memory-overlay-store";
import type { OverlayChangeDefinition, ProposalChange } from "../src/types/proposal";

// ── Helpers ────────────────────────────────────────────────

function makeOverlayChange(overrides?: {
  operation?: "create" | "update" | "delete";
  required?: boolean;
  fieldName?: string;
  entityName?: string;
  fieldType?: "string" | "number" | "boolean" | "date" | "enum" | "json";
}): ProposalChange {
  const entityName = overrides?.entityName ?? "order";
  const fieldName = overrides?.fieldName ?? "custom_color";
  const definition: OverlayChangeDefinition = {
    kind: "overlay",
    entityName,
    overlay: {
      fieldName,
      fieldType: overrides?.fieldType ?? "string",
      config: {
        label: { en: "Custom Color" },
        required: overrides?.required ?? false,
      },
    },
  };

  return {
    target: "overlay",
    operation: overrides?.operation ?? "create",
    name: `${entityName}_${fieldName}`,
    definition,
  };
}

function makeProposalOptions(
  changes: ProposalChange[],
  overrides?: Partial<CreateProposalOptions>,
): CreateProposalOptions {
  return {
    title: "Add overlay field",
    description: "Add a custom color field to order",
    author: { type: "human", id: "user-1", name: "Test User" },
    capability: "test-cap",
    changeType: "patch",
    changes,
    ...overrides,
  };
}

// ── Auto-approval evaluation ───────────────────────────────

describe("canAutoApproveOverlayChange", () => {
  test("optional field creation is auto-approvable", () => {
    const change = makeOverlayChange({ required: false });
    expect(canAutoApproveOverlayChange(change)).toBe(true);
  });

  test("required field creation is NOT auto-approvable", () => {
    const change = makeOverlayChange({ required: true });
    expect(canAutoApproveOverlayChange(change)).toBe(false);
  });

  test("update operation is NOT auto-approvable", () => {
    const change = makeOverlayChange({ operation: "update" });
    expect(canAutoApproveOverlayChange(change)).toBe(false);
  });

  test("delete operation is NOT auto-approvable", () => {
    const change = makeOverlayChange({ operation: "delete" });
    expect(canAutoApproveOverlayChange(change)).toBe(false);
  });

  test("non-overlay change returns false", () => {
    const change: ProposalChange = {
      target: "entity",
      operation: "create",
      name: "order",
    };
    expect(canAutoApproveOverlayChange(change)).toBe(false);
  });

  test("change without definition returns false", () => {
    const change: ProposalChange = {
      target: "overlay",
      operation: "create",
      name: "order.custom_color",
    };
    expect(canAutoApproveOverlayChange(change)).toBe(false);
  });
});

describe("canAutoApproveOverlayProposal", () => {
  test("proposal with only optional overlay creates is auto-approvable", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({ fieldName: "color", required: false }),
        makeOverlayChange({ fieldName: "size", required: false }),
      ]),
    );
    expect(canAutoApproveOverlayProposal(proposal)).toBe(true);
  });

  test("proposal with a required field is NOT auto-approvable", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({ fieldName: "color", required: false }),
        makeOverlayChange({ fieldName: "priority", required: true }),
      ]),
    );
    expect(canAutoApproveOverlayProposal(proposal)).toBe(false);
  });

  test("mixed overlay + entity changes are NOT auto-approvable", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({ fieldName: "color" }),
        { target: "entity", operation: "update", name: "order" },
      ]),
    );
    expect(canAutoApproveOverlayProposal(proposal)).toBe(false);
  });

  test("empty changes list is NOT auto-approvable", () => {
    const engine = new ProposalEngine();
    const proposal = engine.createProposal(makeProposalOptions([]));
    expect(canAutoApproveOverlayProposal(proposal)).toBe(false);
  });
});

// ── Overlay proposal execution ─────────────────────────────

describe("executeOverlayProposal", () => {
  let store: InMemoryOverlayStore;
  let engine: ProposalEngine;

  beforeEach(() => {
    store = new InMemoryOverlayStore();
    engine = new ProposalEngine();
  });

  test("create operation adds overlay to store", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          entityName: "order",
          fieldName: "custom_color",
          fieldType: "string",
        }),
      ]),
    );

    // Simulate committed status
    proposal.status = "committed";

    await executeOverlayProposal({ proposal, store });

    const overlays = await store.getOverlays("order");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.fieldName).toBe("custom_color");
    expect(overlays[0]?.fieldType).toBe("string");
    expect(overlays[0]?.status).toBe("active");
    expect(overlays[0]?.proposalId).toBe(proposal.id);
    expect(overlays[0]?.createdBy).toBe("user-1");
  });

  test("update operation modifies existing overlay", async () => {
    // Pre-populate store
    await store.addOverlay({
      entityName: "order",
      fieldName: "custom_color",
      fieldType: "string",
      config: { label: { en: "Color" } },
      status: "active",
    });

    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          operation: "update",
          entityName: "order",
          fieldName: "custom_color",
          fieldType: "number",
        }),
      ]),
    );
    proposal.status = "committed";

    await executeOverlayProposal({ proposal, store });

    const overlays = await store.getOverlays("order");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.fieldType).toBe("number");
  });

  test("delete operation deprecates the overlay", async () => {
    await store.addOverlay({
      entityName: "order",
      fieldName: "old_field",
      fieldType: "string",
      config: {},
      status: "active",
    });

    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          operation: "delete",
          entityName: "order",
          fieldName: "old_field",
        }),
      ]),
    );
    proposal.status = "committed";

    await executeOverlayProposal({ proposal, store });

    const overlays = await store.getOverlays("order");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.status).toBe("deprecated");
  });

  test("update throws when overlay does not exist", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          operation: "update",
          entityName: "order",
          fieldName: "nonexistent",
        }),
      ]),
    );
    proposal.status = "committed";

    await expect(executeOverlayProposal({ proposal, store })).rejects.toThrow(
      'field "nonexistent" not found on entity "order"',
    );
  });

  test("delete throws when overlay does not exist", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          operation: "delete",
          entityName: "order",
          fieldName: "nonexistent",
        }),
      ]),
    );
    proposal.status = "committed";

    await expect(executeOverlayProposal({ proposal, store })).rejects.toThrow(
      'field "nonexistent" not found on entity "order"',
    );
  });

  test("skips non-overlay changes in the proposal", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        { target: "entity", operation: "update", name: "order" },
        makeOverlayChange({ entityName: "order", fieldName: "color" }),
      ]),
    );
    proposal.status = "committed";

    await executeOverlayProposal({ proposal, store });

    const overlays = await store.getOverlays("order");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.fieldName).toBe("color");
  });

  test("multiple create operations in one proposal", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({ entityName: "order", fieldName: "color" }),
        makeOverlayChange({ entityName: "order", fieldName: "size", fieldType: "enum" }),
        makeOverlayChange({ entityName: "product", fieldName: "weight", fieldType: "number" }),
      ]),
    );
    proposal.status = "committed";

    await executeOverlayProposal({ proposal, store });

    const orderOverlays = await store.getOverlays("order");
    expect(orderOverlays).toHaveLength(2);

    const productOverlays = await store.getOverlays("product");
    expect(productOverlays).toHaveLength(1);
  });
});

// ── Full pipeline integration ──────────────────────────────

describe("Full overlay proposal pipeline", () => {
  let store: InMemoryOverlayStore;
  let engine: ProposalEngine;

  beforeEach(() => {
    store = new InMemoryOverlayStore();
    engine = new ProposalEngine();
  });

  test("draft → validated → approved → committed → overlay appears in store", async () => {
    // Create proposal
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          entityName: "task",
          fieldName: "priority_level",
          fieldType: "number",
          required: false,
        }),
      ]),
    );
    expect(proposal.status).toBe("draft");

    // Submit for validation
    const validated = engine.submitProposal({ proposalId: proposal.id });
    expect(validated.status).toBe("validated");

    // Approve
    const approved = await engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });
    expect(approved.status).toBe("approved");

    // Commit
    const { proposal: committed } = engine.commitProposal({ proposalId: proposal.id });
    expect(committed.status).toBe("committed");

    // Execute overlay changes
    await executeOverlayProposal({ proposal: committed, store });

    // Verify overlay exists
    const overlays = await store.getOverlays("task");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.fieldName).toBe("priority_level");
    expect(overlays[0]?.fieldType).toBe("number");
    expect(overlays[0]?.status).toBe("active");
  });

  test("auto-approval path for optional field addition", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          entityName: "task",
          fieldName: "color_tag",
          fieldType: "string",
          required: false,
        }),
      ]),
    );

    // Check auto-approval eligibility
    expect(canAutoApproveOverlayProposal(proposal)).toBe(true);

    // Submit
    engine.submitProposal({ proposalId: proposal.id });

    // Since auto-approvable, approve with system user
    await engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "system", id: "auto-approval" },
    });

    // Commit and execute
    const { proposal: committed } = engine.commitProposal({ proposalId: proposal.id });
    await executeOverlayProposal({ proposal: committed, store });

    const overlays = await store.getOverlays("task");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.fieldName).toBe("color_tag");
  });

  test("rejected proposal does not affect the store", async () => {
    const proposal = engine.createProposal(
      makeProposalOptions([
        makeOverlayChange({
          entityName: "task",
          fieldName: "secret_field",
          required: true,
        }),
      ]),
    );

    // Confirm manual approval required
    expect(canAutoApproveOverlayProposal(proposal)).toBe(false);

    // Submit
    engine.submitProposal({ proposalId: proposal.id });

    // Reject
    engine.rejectProposal({
      proposalId: proposal.id,
      reason: "Required fields need design review",
    });
    expect(proposal.status).toBe("rejected");

    // No overlay changes should exist
    const overlays = await store.getOverlays("task");
    expect(overlays).toHaveLength(0);
  });
});
