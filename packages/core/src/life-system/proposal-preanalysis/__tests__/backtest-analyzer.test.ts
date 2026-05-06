import { describe, expect, test } from "bun:test";
import type { Actor } from "../../../types/action";
import type { EntityDefinition } from "../../../types/entity";
import type { ExecutionLogEntry } from "../../../types/execution-log";
import type { RuleDefinition } from "../../../types/rule";
import type { StateDefinition } from "../../../types/state";
import { type BacktestDataProvider, createBacktestAnalyzer } from "../backtest-analyzer";
import { makeProposal } from "./fixtures";

// ── Helpers ────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-05-06T00:00:00Z");

const SYSTEM_ACTOR: Actor = { type: "system", id: "sys", groups: [] };

interface MakeExecutionInput {
  id?: string;
  action: string;
  entity?: string;
  recordId?: string;
  input?: Record<string, unknown>;
  status?: ExecutionLogEntry["status"];
  startedAt?: Date;
  stateTransition?: { from: string; to: string };
}

function makeExecution(opts: MakeExecutionInput): ExecutionLogEntry {
  return {
    id: opts.id ?? `exec_${Math.random().toString(16).slice(2, 8)}`,
    action: opts.action,
    entity: opts.entity,
    recordId: opts.recordId,
    actor: SYSTEM_ACTOR,
    input: opts.input ?? {},
    status: opts.status ?? "succeeded",
    stateTransition: opts.stateTransition,
    duration: 5,
    startedAt: opts.startedAt ?? FIXED_NOW,
  };
}

interface MakeProviderOptions {
  executions?: ExecutionLogEntry[];
  /** When provided, exposes the optional listExecutionsByAction provider hook. */
  executionsByAction?: Record<string, ExecutionLogEntry[]>;
  records?: Record<string, Array<Record<string, unknown>>>;
  transitions?: Record<string, Array<{ from: string; to: string; recordId: string }>>;
  failOn?: "executions" | "records" | "transitions";
}

interface RecordedCall {
  kind: "executions" | "records" | "transitions";
  arg: unknown;
}

function makeProvider(
  opts: MakeProviderOptions = {},
): BacktestDataProvider & { calls: RecordedCall[]; lastSince: Date | null } {
  const calls: RecordedCall[] = [];
  let lastSince: Date | null = null;
  const provider: BacktestDataProvider & { calls: RecordedCall[]; lastSince: Date | null } = {
    calls,
    get lastSince() {
      return lastSince;
    },
    set lastSince(v: Date | null) {
      lastSince = v;
    },
    async listExecutionsSince(since) {
      calls.push({ kind: "executions", arg: since });
      lastSince = since;
      if (opts.failOn === "executions") throw new Error("boom-executions");
      return (opts.executions ?? []).filter((e) => e.startedAt >= since);
    },
    async listRecords(entity, limit) {
      calls.push({ kind: "records", arg: { entity, limit } });
      if (opts.failOn === "records") throw new Error("boom-records");
      const all = opts.records?.[entity] ?? [];
      return typeof limit === "number" ? all.slice(0, limit) : all;
    },
  };
  if (opts.executionsByAction) {
    provider.listExecutionsByAction = async (actionNames, since) => {
      calls.push({ kind: "executions", arg: { actionNames, since, indexed: true } });
      lastSince = since;
      const out: ExecutionLogEntry[] = [];
      for (const name of actionNames) {
        out.push(...(opts.executionsByAction?.[name] ?? []));
      }
      return out.filter((e) => e.startedAt >= since);
    };
  }
  if (opts.transitions || opts.failOn === "transitions") {
    provider.listStateTransitions = async (entity, since) => {
      calls.push({ kind: "transitions", arg: { entity, since } });
      lastSince = since;
      if (opts.failOn === "transitions") throw new Error("boom-transitions");
      return opts.transitions?.[entity] ?? [];
    };
  }
  return provider;
}

// ── Tests ───────────────────────────────────────────────────

describe("createBacktestAnalyzer", () => {
  test("returns 0 with summary for code-only proposals", async () => {
    const provider = makeProvider();
    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });

    const proposal = makeProposal({
      changes: [
        {
          target: "view",
          operation: "create",
          name: "purchase_request_list",
          diff: "add default sort",
        },
      ],
    });

    const result = await analyzer.analyze(proposal);

    expect(result.windowDays).toBe(30);
    expect(result.hypotheticalTriggerCount).toBe(0);
    expect(result.summary).toBe("no replayable changes");
    expect(provider.calls).toHaveLength(0);
  });

  test("rule target with declarative condition counts matching past executions", async () => {
    const executions: ExecutionLogEntry[] = [
      makeExecution({
        id: "e1",
        action: "submit_request",
        input: { amount: 1000 },
      }),
      makeExecution({
        id: "e2",
        action: "submit_request",
        input: { amount: 500 },
      }),
      makeExecution({
        id: "e3",
        action: "submit_request",
        input: { amount: 2000 },
      }),
      // Wrong action — must not count even if condition would match.
      makeExecution({
        id: "e4",
        action: "approve_request",
        input: { amount: 1500 },
      }),
    ];
    const provider = makeProvider({ executions });

    const ruleDef: RuleDefinition = {
      name: "high_value_block",
      label: "High value block",
      trigger: { action: "submit_request" },
      // Field paths resolve from ConditionContext root; the execution input is
      // wired into `target`, so condition fields walk through `target.*`.
      condition: { field: "target.amount", operator: "gte", value: 1000 },
      effect: { type: "block", message: "too much" },
    };
    const proposal = makeProposal({
      changes: [
        {
          target: "rule",
          operation: "create",
          name: ruleDef.name,
          definition: ruleDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    // e1 (1000) and e3 (2000) match; e2 (500) doesn't, e4 wrong action.
    expect(result.hypotheticalTriggerCount).toBe(2);
    expect(result.summary).toBeUndefined();
  });

  test("rule target with code condition surfaces non-evaluable summary and 0 count", async () => {
    const provider = makeProvider({
      executions: [makeExecution({ action: "submit_request", input: { amount: 9999 } })],
    });

    const ruleDef: RuleDefinition = {
      name: "code_rule",
      label: "Code rule",
      trigger: { action: "submit_request" },
      condition: () => true,
      effect: { type: "warn", message: "warn" },
    };
    const proposal = makeProposal({
      changes: [
        {
          target: "rule",
          operation: "create",
          name: ruleDef.name,
          definition: ruleDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    expect(result.hypotheticalTriggerCount).toBe(0);
    expect(result.summary).toBe("rule conditions not statically evaluable");
  });

  test("state target counts transitions made illegal by the proposed machine", async () => {
    // Proposed machine drops the `cancelled` state and the draft→cancelled transition.
    const stateDef: StateDefinition = {
      name: "purchase_request_status",
      entity: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "approved"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit_request" },
        { from: "submitted", to: "approved", action: "approve_request" },
      ],
    };
    const provider = makeProvider({
      transitions: {
        purchase_request: [
          { from: "draft", to: "submitted", recordId: "pr_1" },
          { from: "draft", to: "cancelled", recordId: "pr_2" }, // illegal
          { from: "submitted", to: "cancelled", recordId: "pr_3" }, // illegal
          { from: "submitted", to: "approved", recordId: "pr_4" },
        ],
      },
    });
    const proposal = makeProposal({
      changes: [
        {
          target: "state",
          operation: "update",
          name: stateDef.name,
          definition: stateDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    expect(result.hypotheticalTriggerCount).toBe(2);
  });

  test("state target falls back to execution log scanning when listStateTransitions is absent", async () => {
    const stateDef: StateDefinition = {
      name: "order_lifecycle",
      entity: "order",
      field: "status",
      initial: "new",
      states: ["new", "shipped"],
      transitions: [{ from: "new", to: "shipped", action: "ship_order" }],
    };
    const provider = makeProvider({
      executions: [
        makeExecution({
          action: "ship_order",
          entity: "order",
          stateTransition: { from: "new", to: "shipped" },
        }),
        makeExecution({
          action: "cancel_order",
          entity: "order",
          stateTransition: { from: "new", to: "cancelled" }, // illegal
        }),
        makeExecution({
          action: "refund_order",
          entity: "order",
          stateTransition: { from: "shipped", to: "refunded" }, // illegal
        }),
      ],
    });
    const proposal = makeProposal({
      changes: [
        {
          target: "state",
          operation: "update",
          name: stateDef.name,
          definition: stateDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    expect(result.hypotheticalTriggerCount).toBe(2);
    expect(provider.calls.some((c) => c.kind === "executions")).toBe(true);
  });

  test("entity target counts records that violate a newly-required field", async () => {
    const entityDef: EntityDefinition = {
      name: "purchase_request",
      fields: {
        priority: { type: "string", required: true },
      },
    };
    const provider = makeProvider({
      records: {
        purchase_request: [
          { id: "pr_1", priority: "high" },
          { id: "pr_2", priority: null },
          { id: "pr_3" }, // missing key entirely
          { id: "pr_4", priority: "low" },
          { id: "pr_5", priority: undefined },
        ],
      },
    });
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: entityDef.name,
          definition: entityDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    // pr_2 (null), pr_3 (missing), pr_5 (undefined) all violate.
    expect(result.hypotheticalTriggerCount).toBe(3);
  });

  test("entity target counts records violating new enum constraints", async () => {
    const entityDef: EntityDefinition = {
      name: "purchase_request",
      fields: {
        status: {
          type: "enum",
          options: [{ value: "draft" }, { value: "submitted" }, { value: "approved" }],
        },
      },
    };
    const provider = makeProvider({
      records: {
        purchase_request: [
          { id: "1", status: "draft" },
          { id: "2", status: "rejected" }, // not in new enum
          { id: "3", status: "submitted" },
          { id: "4", status: "legacy" }, // not in new enum
        ],
      },
    });
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: entityDef.name,
          definition: entityDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    expect(result.hypotheticalTriggerCount).toBe(2);
  });

  test("entity:create skips replay (no historical rows yet)", async () => {
    const entityDef: EntityDefinition = {
      name: "brand_new",
      fields: { name: { type: "string", required: true } },
    };
    const provider = makeProvider();
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "create",
          name: entityDef.name,
          definition: entityDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    expect(result.hypotheticalTriggerCount).toBe(0);
    expect(result.summary).toContain("entity:create-no-history");
    expect(provider.calls).toHaveLength(0);
  });

  test("custom windowDays is honored and propagated to the data provider", async () => {
    const provider = makeProvider({
      transitions: { purchase_request: [] },
    });
    const stateDef: StateDefinition = {
      name: "purchase_request_status",
      entity: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft"],
      transitions: [],
    };
    const proposal = makeProposal({
      changes: [
        {
          target: "state",
          operation: "update",
          name: stateDef.name,
          definition: stateDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
      windowDays: 7,
    });
    const result = await analyzer.analyze(proposal);

    expect(result.windowDays).toBe(7);
    // Lower bound = now - 7 days.
    const expected = new Date(FIXED_NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(provider.lastSince?.toISOString()).toBe(expected.toISOString());
  });

  test("invalid windowDays falls back to the 30-day default", async () => {
    const provider = makeProvider();
    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
      windowDays: -5,
    });
    const proposal = makeProposal({
      changes: [{ target: "view", operation: "create", name: "v" }],
    });
    const result = await analyzer.analyze(proposal);
    expect(result.windowDays).toBe(30);
  });

  test("never throws when the data provider fails — surfaces error in summary", async () => {
    const provider = makeProvider({ failOn: "records" });
    const entityDef: EntityDefinition = {
      name: "purchase_request",
      fields: { priority: { type: "string", required: true } },
    };
    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: entityDef.name,
          definition: entityDef,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });

    const result = await analyzer.analyze(proposal);
    expect(result.hypotheticalTriggerCount).toBe(0);
    expect(result.summary).toContain("boom-records");
    expect(result.summary).toContain("purchase_request");
  });

  test("aggregates counts across multiple replayable changes", async () => {
    const ruleDef: RuleDefinition = {
      name: "high_value",
      label: "High value",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gte", value: 1000 },
      effect: { type: "block", message: "x" },
    };
    const stateDef: StateDefinition = {
      name: "purchase_request_status",
      entity: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted"],
      transitions: [{ from: "draft", to: "submitted", action: "submit_request" }],
    };

    const provider = makeProvider({
      executions: [
        makeExecution({ action: "submit_request", input: { amount: 5000 } }),
        makeExecution({ action: "submit_request", input: { amount: 100 } }),
        makeExecution({ action: "submit_request", input: { amount: 9999 } }),
      ],
      transitions: {
        purchase_request: [
          { from: "draft", to: "submitted", recordId: "1" },
          { from: "draft", to: "cancelled", recordId: "2" }, // illegal
        ],
      },
    });

    const proposal = makeProposal({
      changes: [
        { target: "rule", operation: "create", name: ruleDef.name, definition: ruleDef },
        { target: "state", operation: "update", name: stateDef.name, definition: stateDef },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);

    // 2 high-amount executions + 1 illegal transition = 3.
    expect(result.hypotheticalTriggerCount).toBe(3);
  });

  test("rule target without a definition contributes 0 with note", async () => {
    const provider = makeProvider();
    const proposal = makeProposal({
      changes: [{ target: "rule", operation: "delete", name: "old_rule" }],
    });
    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
    });
    const result = await analyzer.analyze(proposal);
    // Without a definition the change is filtered out as non-replayable.
    expect(result.hypotheticalTriggerCount).toBe(0);
    expect(result.summary).toBe("no replayable changes");
  });

  test("prefers listExecutionsByAction when the provider exposes it", async () => {
    const matching: ExecutionLogEntry[] = [
      makeExecution({ id: "a1", action: "submit_request", input: { amount: 1000 } }),
      makeExecution({ id: "a2", action: "submit_request", input: { amount: 1500 } }),
    ];
    const provider = makeProvider({
      executionsByAction: { submit_request: matching },
      // listExecutionsSince is still wired but should not be called.
      executions: [makeExecution({ id: "x", action: "submit_request", input: { amount: 9999 } })],
    });

    const ruleDef: RuleDefinition = {
      name: "high_value_block",
      label: "block",
      trigger: { action: "submit_request" },
      condition: { field: "target.amount", operator: "gte", value: 1000 },
      effect: { type: "block", message: "x" },
    };
    const proposal = makeProposal({
      changes: [{ target: "rule", operation: "create", name: ruleDef.name, definition: ruleDef }],
    });

    const analyzer = createBacktestAnalyzer({ dataProvider: provider, now: () => FIXED_NOW });
    const result = await analyzer.analyze(proposal);

    // Both indexed entries should match — sentinel from listExecutionsSince must be ignored.
    expect(result.hypotheticalTriggerCount).toBe(2);
    expect(provider.calls.some((c) => c.kind === "executions")).toBe(true);
    expect(
      provider.calls.find((c) => c.kind === "executions")?.arg as {
        indexed?: boolean;
      },
    ).toMatchObject({ indexed: true, actionNames: ["submit_request"] });
  });

  test("ctxFromExecution exposes from/to from stateTransition for declarative conditions", async () => {
    const executions: ExecutionLogEntry[] = [
      makeExecution({
        id: "t1",
        action: "advance_state",
        entity: "purchase_request",
        input: {},
        stateTransition: { from: "draft", to: "submitted" },
      }),
      makeExecution({
        id: "t2",
        action: "advance_state",
        entity: "purchase_request",
        input: {},
        stateTransition: { from: "submitted", to: "approved" },
      }),
    ];
    const provider = makeProvider({ executions });

    const ruleDef: RuleDefinition = {
      name: "audit_initial_submit",
      label: "audit",
      trigger: { action: "advance_state" },
      // Condition reads context.to — only the submitted-bound transition matches.
      condition: { field: "context.to", operator: "eq", value: "submitted" },
      effect: { type: "block", message: "x" },
    };
    const proposal = makeProposal({
      changes: [{ target: "rule", operation: "create", name: ruleDef.name, definition: ruleDef }],
    });

    const analyzer = createBacktestAnalyzer({ dataProvider: provider, now: () => FIXED_NOW });
    const result = await analyzer.analyze(proposal);

    expect(result.hypotheticalTriggerCount).toBe(1);
  });

  test("entity replay caps scan at maxRecordsToScan and surfaces a truncation note", async () => {
    const entity: EntityDefinition = {
      name: "purchase_request",
      fields: { reference: { type: "string", required: true, label: "Reference" } },
    };
    // 250 records, half violate (no reference). The test caps at 100 — we expect
    // only the first 100 to be inspected.
    const records = Array.from({ length: 250 }, (_, i) => ({
      reference: i % 2 === 0 ? null : `REQ-${i}`,
    }));
    const provider = makeProvider({ records: { purchase_request: records } });

    const proposal = makeProposal({
      changes: [
        {
          target: "entity",
          operation: "update",
          name: entity.name,
          definition: entity,
        },
      ],
    });

    const analyzer = createBacktestAnalyzer({
      dataProvider: provider,
      now: () => FIXED_NOW,
      maxRecordsToScan: 100,
    });
    const result = await analyzer.analyze(proposal);

    // Half of the first 100 violate → 50.
    expect(result.hypotheticalTriggerCount).toBe(50);
    expect(result.summary).toContain("entity:scan-truncated:100");
    // Provider was asked with limit `maxRecordsToScan + 1` so the analyzer
    // can detect overflow without trusting the hint to be honored.
    const recordsCall = provider.calls.find((c) => c.kind === "records");
    expect(recordsCall?.arg as { entity: string; limit: number | undefined }).toMatchObject({
      entity: "purchase_request",
      limit: 101,
    });
  });
});
