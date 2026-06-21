/**
 * Shared harness, actors, actions, and fixtures for agui-resume tests.
 *
 * Split from agui-resume.test.ts (Spec 71 P2b) to keep individual test files
 * under the 500-line guideline (#607).
 */

import type { AGUIEvent, InterruptStore, ResumeEntry } from "@linchkit/cap-adapter-ag-ui";
import { InMemoryInterruptStore } from "@linchkit/cap-adapter-ag-ui";
import type { ActionDefinition, Actor, CommandExecuteOptions, CommandLayer } from "@linchkit/core";
import { createActionExecutor, createCommandLayer, InMemoryStore } from "@linchkit/core/server";
import { buildProposeInterrupt, computeInputDigest } from "../../agui-interrupt";

// ── Actors ──────────────────────────────────────────────────

export const ALICE: Actor = { type: "human", id: "alice", groups: ["admin"] };
export const BOB: Actor = { type: "human", id: "bob", groups: ["admin"] };
/** A user WITHOUT the group create_product requires (permission DENY case). */
export const VIEWER: Actor = { type: "human", id: "viewer", groups: ["viewer"] };

// ── Actions ─────────────────────────────────────────────────

export const createProduct: ActionDefinition = {
  name: "create_product",
  entity: "product",
  label: "Create Product",
  input: {
    name: { type: "string", required: true, label: "Name" },
    price: { type: "number", label: "Price" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => ctx.create("product", ctx.input),
};

/** A second product action — the server-offered SWAP alternative (§2.5). */
export const updateProduct: ActionDefinition = {
  name: "update_product",
  entity: "product",
  label: "Update Product",
  input: {
    id: { type: "string", required: true, label: "ID" },
    price: { type: "number", label: "Price" },
  },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const { id, ...rest } = ctx.input as { id: string; [k: string]: unknown };
    return ctx.update("product", id, rest);
  },
};

/** An action NOT in any interrupt's vetted set — the forged-swap target. */
export const deleteProduct: ActionDefinition = {
  name: "delete_product",
  entity: "product",
  label: "Delete Product",
  input: { id: { type: "string", required: true, label: "ID" } },
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const { id } = ctx.input as { id: string };
    return ctx.delete("product", id);
  },
};

// ── Test harness: real CommandLayer with a permission slot ──

export interface Harness {
  store: InMemoryStore;
  commandLayer: CommandLayer;
  /** The last `execute` options seen (for §6.6 provenance + permission asserts). */
  lastExecute: () => CommandExecuteOptions | undefined;
  /** How many times execute() ran (single-execution assertions). */
  executeCount: () => number;
}

export function buildHarness(): Harness {
  const store = new InMemoryStore();
  const executor = createActionExecutor({ dataProvider: store });
  executor.registry.register(createProduct);
  executor.registry.register(updateProduct);
  executor.registry.register(deleteProduct);

  const inner = createCommandLayer({ executor });

  // A minimal permission slot to PROVE it runs unconditionally on the resume
  // path (§6.1). It denies any actor lacking the "admin" group — so VIEWER is
  // rejected by CommandLayer even after human approval (§6.4 execute-time).
  inner.use({
    name: "test-permission",
    slot: "permission",
    handler: async (ctx, next) => {
      const groups = ctx.actor.groups ?? [];
      if (!groups.includes("admin")) {
        throw new Error(`not allowed: actor "${ctx.actor.id}" lacks admin`);
      }
      await next();
    },
  });

  let last: CommandExecuteOptions | undefined;
  let count = 0;
  // Spy proxy: spread the real CommandLayer (picks up `use` / `executeBatch` /
  // `getMiddlewares`) and override only `execute` to record the options (for
  // provenance + permission asserts) before delegating — the permission slot
  // still runs through the real pipeline.
  const commandLayer: CommandLayer = {
    ...inner,
    execute: (options) => {
      last = options;
      count += 1;
      return inner.execute(options);
    },
  };

  return {
    store,
    commandLayer,
    lastExecute: () => last,
    executeCount: () => count,
  };
}

// ── Run A: write the interrupt store entry (what the runner does) ──

export interface ProposeResult {
  interruptId: string;
  inputDigest: string;
}

export function propose(options: {
  store: InMemoryInterruptStore;
  proposerActor: Actor;
  tenant?: string;
  action?: string;
  input?: Record<string, unknown>;
  actionSet?: string[];
  approvalWindowMs?: number;
  now?: number;
  interruptId?: string;
}): ProposeResult {
  const action = options.action ?? "create_product";
  const input = options.input ?? { name: "Widget", price: 9.9 };
  const interruptId = options.interruptId ?? "int-1";
  buildProposeInterrupt({
    threadId: "t1",
    proposal: { action, input },
    proposerActor: options.proposerActor,
    tenant: options.tenant,
    store: options.store,
    interruptId,
    ...(options.approvalWindowMs !== undefined
      ? { approvalWindowMs: options.approvalWindowMs }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  // For action-set tests we expand the stored set beyond the primary action
  // (the runner would write [primary, ...alternatives]; P2a writes [primary],
  // so we overwrite to simulate a server that offered an alternative).
  if (options.actionSet) {
    const entry = options.store.get("t1", interruptId);
    if (entry) options.store.put({ ...entry, actionSet: options.actionSet });
  }
  return { interruptId, inputDigest: computeInputDigest(action, input) };
}

export function resolvedResume(options: {
  interruptId: string;
  action: string;
  input: Record<string, unknown>;
  baseDigest: string;
}): ResumeEntry {
  return {
    interruptId: options.interruptId,
    status: "resolved",
    payload: {
      action: options.action,
      input: options.input,
      baseDigest: options.baseDigest,
    },
  };
}

/** Collect emitted events for a `runAgUiResume` call. */
export function collector(): { emit: (e: AGUIEvent) => void; events: AGUIEvent[] } {
  const events: AGUIEvent[] = [];
  return { emit: (e) => events.push(e), events };
}

export async function productCount(store: InMemoryStore): Promise<number> {
  return (await store.query("product", {})).length;
}

export type { InterruptStore };
// Re-export store type so test files don't need to import it themselves.
export { InMemoryInterruptStore };
