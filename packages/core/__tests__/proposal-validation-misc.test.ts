import { describe, expect, it } from "bun:test";
import { bumpVersion, validatePhase1, validateProposal } from "../src/server-entry";
import { baseProposalOptions, createTestEngine } from "./proposal-test-helpers";

// ── validateProposal ────────────────────────────────────

describe("validateProposal", () => {
  it("returns full validation result with all 4 phases", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const result = validateProposal({ proposal });

    expect(result.phases).toHaveLength(4);
    expect(result.phases[0].phase).toBe(1);
    expect(result.phases[0].status).toBe("passed");
    expect(result.phases[1].phase).toBe(2);
    expect(result.phases[1].status).toBe("skipped");
    expect(result.phases[2].phase).toBe(3);
    expect(result.phases[2].status).toBe("skipped");
    expect(result.phases[3].phase).toBe(4);
    expect(result.phases[3].status).toBe("skipped");
    expect(result.impactSummary).toContain("1 change(s)");
  });
});

// ── bumpVersion ─────────────────────────────────────────

describe("bumpVersion", () => {
  it("bumps patch version", () => {
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
  });

  it("bumps minor version and resets patch", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });

  it("bumps major version and resets minor/patch", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
  });

  it("handles 0.0.0", () => {
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
    expect(bumpVersion("0.0.0", "minor")).toBe("0.1.0");
    expect(bumpVersion("0.0.0", "major")).toBe("1.0.0");
  });

  it("throws for invalid semver", () => {
    expect(() => bumpVersion("not.a.version", "patch")).toThrow("Invalid semver");
    expect(() => bumpVersion("1.2", "patch")).toThrow("Invalid semver");
  });
});

// ── Full lifecycle: happy path ──────────────────────────

describe("Full proposal lifecycle", () => {
  it("draft → validated → approved → committed → deployed", async () => {
    const engine = createTestEngine();

    // Create
    const proposal = engine.createProposal(baseProposalOptions);
    expect(proposal.status).toBe("draft");

    // Submit (validate)
    engine.submitProposal({ proposalId: proposal.id });
    expect(engine.getProposal(proposal.id).status).toBe("validated");

    // Approve
    await engine.approveProposal({
      proposalId: proposal.id,
      approvedBy: { type: "human", id: "admin-1" },
    });
    expect(engine.getProposal(proposal.id).status).toBe("approved");

    // Commit
    const { version } = engine.commitProposal({
      proposalId: proposal.id,
      previousVersion: "1.0.0",
      changelog: "Added product schema",
    });
    expect(engine.getProposal(proposal.id).status).toBe("committed");
    expect(version.version).toBe("1.1.0");
    expect(version.status).toBe("active");

    // Deploy
    engine.deployProposal({ proposalId: proposal.id });
    expect(engine.getProposal(proposal.id).status).toBe("deployed");
  });

  it("draft → validated → rejected", () => {
    const engine = createTestEngine();

    const proposal = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: proposal.id });
    engine.rejectProposal({
      proposalId: proposal.id,
      reason: "Too many changes at once",
    });

    const rejected = engine.getProposal(proposal.id);
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectionReason).toBe("Too many changes at once");
  });
});

// ── P1: Duplicate version detection ─────────────────────

describe("ProposalEngine: duplicate version detection", () => {
  it("auto-detects latest version when previousVersion is not provided", async () => {
    const engine = createTestEngine();

    // First proposal: commits as 0.1.0
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    await engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    const { version: v1 } = engine.commitProposal({ proposalId: p1.id });
    expect(v1.version).toBe("0.1.0");

    // Second proposal: should auto-detect 0.1.0 and bump to 0.2.0
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Second" });
    engine.submitProposal({ proposalId: p2.id });
    await engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });
    const { version: v2 } = engine.commitProposal({ proposalId: p2.id });
    expect(v2.version).toBe("0.2.0");
    expect(v2.previousVersion).toBe("0.1.0");
  });

  it("throws when committing would create a duplicate version", async () => {
    const engine = createTestEngine();

    // First proposal: commits as 1.1.0
    const p1 = engine.createProposal(baseProposalOptions);
    engine.submitProposal({ proposalId: p1.id });
    await engine.approveProposal({ proposalId: p1.id, approvedBy: { type: "human", id: "a" } });
    engine.commitProposal({ proposalId: p1.id, previousVersion: "1.0.0" });

    // Second proposal with explicit previousVersion that would create the same version
    const p2 = engine.createProposal({ ...baseProposalOptions, title: "Duplicate" });
    engine.submitProposal({ proposalId: p2.id });
    await engine.approveProposal({ proposalId: p2.id, approvedBy: { type: "human", id: "a" } });

    expect(() => engine.commitProposal({ proposalId: p2.id, previousVersion: "1.0.0" })).toThrow(
      'Version "1.1.0" already exists',
    );
  });
});

// ── P1: stateTransition validation against state machine ─

describe("validatePhase1: stateTransition against state machine", () => {
  it("fails when stateTransition.from references invalid state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed", "done"],
            transitions: [
              { from: "draft", to: "confirmed", action: "confirm" },
              { from: "confirmed", to: "done", action: "complete" },
            ],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "confirm_order",
          definition: {
            name: "confirm_order",
            entity: "order",
            label: "Confirm Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "nonexistent", to: "confirmed" },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    expect(result.errors.find((e) => e.code === "TRANSITION_INVALID_STATE")?.message).toContain(
      "'nonexistent'",
    );
  });

  it("fails when stateTransition.to references invalid state", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed"],
            transitions: [{ from: "draft", to: "confirmed", action: "confirm" }],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "ship_order",
          definition: {
            name: "ship_order",
            entity: "order",
            label: "Ship Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "confirmed", to: "shipped" },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "TRANSITION_INVALID_STATE")).toBe(true);
    expect(result.errors.find((e) => e.code === "TRANSITION_INVALID_STATE")?.message).toContain(
      "'shipped'",
    );
  });

  it("passes when stateTransition references valid states", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "order",
          definition: {
            name: "order",
            fields: { title: { type: "string", label: "Title" } },
          },
        },
        {
          target: "state",
          operation: "create",
          name: "order_lifecycle",
          definition: {
            name: "order_lifecycle",
            entity: "order",
            field: "status",
            initial: "draft",
            states: ["draft", "confirmed"],
            transitions: [{ from: "draft", to: "confirmed", action: "confirm" }],
          },
        },
        {
          target: "action",
          operation: "create",
          name: "confirm_order",
          definition: {
            name: "confirm_order",
            entity: "order",
            label: "Confirm Order",
            policy: { mode: "sync", transaction: true },
            stateTransition: { from: "draft", to: "confirmed" },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "TRANSITION_INVALID_STATE")).toHaveLength(0);
  });
});

// ── P1: Phase 2 skipped doesn't block passed ────────────

describe("validateProposal: skipped phases don't block passed", () => {
  it("passes when Phase 1 passes and other phases are skipped", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal(baseProposalOptions);

    const result = validateProposal({ proposal });

    expect(result.passed).toBe(true);
    expect(result.phases[0].status).toBe("passed");
    expect(result.phases[1].status).toBe("skipped");
    expect(result.phases[2].status).toBe("skipped");
    expect(result.phases[3].status).toBe("skipped");
  });

  it("fails when Phase 1 fails even though other phases are skipped", () => {
    const engine = createTestEngine();
    const proposal = engine.createProposal({
      ...baseProposalOptions,
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "empty",
          definition: { name: "empty", fields: {} },
        },
      ],
    });

    const result = validateProposal({ proposal });

    expect(result.passed).toBe(false);
    expect(result.phases[0].status).toBe("failed");
  });
});

// ── P2: Required without default is now an error ─────────

describe("validatePhase1: required field without default is error", () => {
  it("reports an error for required field without default", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              name: { type: "string", required: true, label: "Name" },
            },
          },
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.errors.some((e) => e.code === "REQUIRED_NO_DEFAULT")).toBe(true);
  });

  it("does not error for required field with a default value", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              name: { type: "string", required: true, default: "Untitled", label: "Name" },
            },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
  });

  it("does not error for computed required fields without default", () => {
    const result = validatePhase1({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: "product",
          definition: {
            name: "product",
            fields: {
              total: { type: "computed", required: true, label: "Total" },
            },
          },
        },
      ],
    });

    expect(result.errors.filter((e) => e.code === "REQUIRED_NO_DEFAULT")).toHaveLength(0);
  });
});
