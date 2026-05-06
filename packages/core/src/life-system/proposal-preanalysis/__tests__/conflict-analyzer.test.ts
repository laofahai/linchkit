import { describe, expect, test } from "bun:test";
import type { ProposalDefinition } from "../../../types/proposal";
import type { RuleDefinition } from "../../../types/rule";
import type { StateDefinition } from "../../../types/state";
import {
  createConflictAnalyzer,
  type LiveRuleStore,
  type LiveStateStore,
} from "../conflict-analyzer";
import type { PendingProposalStore } from "../types";
import { makeProposal } from "./fixtures";

function makeStore(proposals: ProposalDefinition[]): PendingProposalStore {
  return {
    async listPending() {
      return proposals;
    },
  };
}

function makeRuleStore(rules: RuleDefinition[]): LiveRuleStore {
  return {
    async listRules() {
      return rules;
    },
  };
}

function makeStateStore(states: StateDefinition[]): LiveStateStore {
  return {
    async listStates() {
      return states;
    },
  };
}

function makeRule(name: string): RuleDefinition {
  return {
    name,
    label: name,
    trigger: { event: "noop" },
    condition: { field: "x", operator: "eq", value: 1 },
    effect: { type: "warn", message: "test" },
  };
}

function makeStateDef(opts: {
  name: string;
  states: string[];
  transitions?: Array<{ from: string | string[]; to: string; action: string }>;
}): StateDefinition {
  return {
    name: opts.name,
    entity: "purchase_request",
    field: "status",
    initial: opts.states[0] ?? "draft",
    states: opts.states,
    transitions: opts.transitions ?? [],
  };
}

describe("createConflictAnalyzer", () => {
  test("returns no conflicts when every store is empty", async () => {
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveRules: makeRuleStore([]),
      liveStates: makeStateStore([]),
    });
    const candidate = makeProposal({ id: "prop_candidate" });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
    expect(result.notes).toContain("checked: pendingProposals");
  });

  test("flags a proposal-vs-proposal conflict when peers share an artifact", async () => {
    const peer = makeProposal({
      id: "prop_peer",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "rename priority",
        },
      ],
    });
    const candidate = makeProposal({ id: "prop_candidate" });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([peer]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe("proposal");
    expect(result.conflicts[0]?.targetId).toBe("prop_peer");
    expect(result.conflicts[0]?.message).toContain("purchase_request");
  });

  test("ignores the candidate itself when present in the pending store", async () => {
    const candidate = makeProposal({ id: "prop_self" });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([candidate]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
  });

  test("ignores peers in non-pending statuses", async () => {
    const approved = makeProposal({ id: "prop_approved", status: "approved" });
    const candidate = makeProposal({ id: "prop_candidate" });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([approved]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
  });

  test("ignores peers whose changes are payload-empty (no definition, no diff)", async () => {
    const peer = makeProposal({
      id: "prop_peer",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          // no diff, no definition — nothing to actually compare against
        },
      ],
    });
    const candidate = makeProposal({ id: "prop_candidate" });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([peer]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
  });

  test("flags a rule conflict when the proposed rule name already exists live", async () => {
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "rule",
          operation: "create",
          name: "budget_block",
          diff: "block over budget",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveRules: makeRuleStore([makeRule("budget_block")]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe("rule");
    expect(result.conflicts[0]?.targetId).toBe("budget_block");
  });

  test("does not flag a rule conflict for unrelated live rules", async () => {
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "rule",
          operation: "create",
          name: "new_rule",
          diff: "add",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveRules: makeRuleStore([makeRule("other_rule")]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
  });

  test("notes when rule changes are present but liveRules store is missing", async () => {
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "rule",
          operation: "create",
          name: "new_rule",
          diff: "add",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
    expect(result.notes).toContain("liveRules: store not provided");
  });

  test("flags state_transition conflict when proposed update removes a state used by a transition", async () => {
    const liveState = makeStateDef({
      name: "purchase_request_status",
      states: ["draft", "submitted", "approved"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit" },
        { from: "submitted", to: "approved", action: "approve" },
      ],
    });
    const proposedDef = makeStateDef({
      name: "purchase_request_status",
      // "submitted" removed — both live transitions reference it
      states: ["draft", "approved"],
      transitions: [{ from: "draft", to: "approved", action: "approve" }],
    });
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "state",
          operation: "update",
          name: "purchase_request_status",
          definition: proposedDef as never,
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveStates: makeStateStore([liveState]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);
    for (const finding of result.conflicts) {
      expect(finding.kind).toBe("state_transition");
      expect(finding.targetId).toBe("purchase_request_status");
      expect(finding.message).toContain("submitted");
    }
  });

  test("does not flag state_transition conflict when proposed states keep all referenced ones", async () => {
    const liveState = makeStateDef({
      name: "purchase_request_status",
      states: ["draft", "submitted"],
      transitions: [{ from: "draft", to: "submitted", action: "submit" }],
    });
    const proposedDef = makeStateDef({
      name: "purchase_request_status",
      // adding a new state but keeping the old ones
      states: ["draft", "submitted", "approved"],
      transitions: [{ from: "draft", to: "submitted", action: "submit" }],
    });
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "state",
          operation: "update",
          name: "purchase_request_status",
          definition: proposedDef as never,
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveStates: makeStateStore([liveState]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
  });

  test("flags state_transition when deleting a state machine that has live transitions", async () => {
    const liveState = makeStateDef({
      name: "purchase_request_status",
      states: ["draft", "submitted"],
      transitions: [{ from: "draft", to: "submitted", action: "submit" }],
    });
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "state",
          operation: "delete",
          name: "purchase_request_status",
          diff: "remove status machine",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveStates: makeStateStore([liveState]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe("state_transition");
    expect(result.conflicts[0]?.targetId).toBe("purchase_request_status");
  });

  test("notes when state update has no parsable definition", async () => {
    const liveState = makeStateDef({
      name: "purchase_request_status",
      states: ["draft", "submitted"],
      transitions: [{ from: "draft", to: "submitted", action: "submit" }],
    });
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "state",
          operation: "update",
          name: "purchase_request_status",
          diff: "tweak meta only",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveStates: makeStateStore([liveState]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
    expect(result.notes).toContain("update definition missing or malformed");
  });

  test("treats state update with non-string state entries as malformed", async () => {
    const liveState = makeStateDef({
      name: "purchase_request_status",
      states: ["draft", "submitted"],
      transitions: [{ from: "draft", to: "submitted", action: "submit" }],
    });
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "state",
          operation: "update",
          name: "purchase_request_status",
          // states contains a non-string entry — must NOT be parsed as a real
          // StateDefinition or the analyzer will emit false transition conflicts.
          definition: {
            name: "purchase_request_status",
            states: ["draft", 42, "submitted"],
            transitions: [],
          } as unknown as StateDefinition,
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveStates: makeStateStore([liveState]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
    expect(result.notes).toContain("update definition missing or malformed");
  });

  test("supports synchronous live stores (returning arrays directly)", async () => {
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "rule",
          operation: "create",
          name: "sync_rule",
          diff: "add",
        },
      ],
    });
    const liveRules: LiveRuleStore = {
      // Synchronous return — analyzer must `await` either way
      listRules: () => [makeRule("sync_rule")],
    };
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([]),
      liveRules,
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe("rule");
  });

  test("captures a thrown analyzer source into notes without panicking", async () => {
    const failingStore: PendingProposalStore = {
      async listPending() {
        throw new Error("db unreachable");
      },
    };
    const failingRules: LiveRuleStore = {
      listRules() {
        throw new Error("rule registry boom");
      },
    };
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "rule",
          operation: "create",
          name: "any_rule",
          diff: "add",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: failingStore,
      liveRules: failingRules,
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(0);
    expect(result.notes).toContain("pendingProposals: db unreachable");
    expect(result.notes).toContain("liveRules: rule registry boom");
  });

  test("respects custom pendingStatuses override", async () => {
    const peer = makeProposal({
      id: "prop_peer",
      status: "committed",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "rename priority",
        },
      ],
    });
    const candidate = makeProposal({ id: "prop_candidate" });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([peer]),
      pendingStatuses: new Set(["committed"]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe("proposal");
    expect(result.conflicts[0]?.targetId).toBe("prop_peer");
  });

  test("emits one finding per peer per shared artifact", async () => {
    const peer = makeProposal({
      id: "prop_peer",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "first edit",
        },
        {
          target: "rule",
          operation: "create",
          name: "shared_rule",
          diff: "rule edit",
        },
      ],
    });
    const candidate = makeProposal({
      id: "prop_candidate",
      changes: [
        {
          target: "entity",
          operation: "update",
          name: "purchase_request",
          diff: "second edit",
        },
        {
          target: "rule",
          operation: "create",
          name: "shared_rule",
          diff: "rule edit",
        },
      ],
    });
    const analyzer = createConflictAnalyzer({
      pendingProposals: makeStore([peer]),
    });

    const result = await analyzer.analyze(candidate);

    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.every((c) => c.kind === "proposal")).toBe(true);
    expect(result.conflicts.every((c) => c.targetId === "prop_peer")).toBe(true);
  });
});
