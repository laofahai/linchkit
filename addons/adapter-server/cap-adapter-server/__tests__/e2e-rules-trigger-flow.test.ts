/**
 * E2E Test: `trigger_flow` rule effect on the in-process boot path (#476).
 *
 * Proves that a `trigger_flow` rule effect actually STARTS its flow when the app
 * is assembled via `createDevApp` — the DB-free, in-process boot path that
 * `assembleDevSchema` → `createRuntimeContext` backs. Before #476 this path never
 * built a flow engine nor aggregated capability flows, so a `trigger_flow` effect
 * silently logged + skipped (`flowEngine` was undefined). The fix makes the path
 * build a default in-process `SyncFlowEngine` from the capabilities' flows so the
 * effect runs (Spec 23 §1.1 / Spec 26 §2.2). The `linch dev` boot path still
 * injects its durable engine via `flowEngine`, which always wins — unaffected.
 *
 * Setup mirrors the other adapter-server e2e suites:
 *  - In-process, port-free: requests are dispatched via `app.handle(new Request(...))`.
 *    NEVER `app.listen(PORT)` — a bound socket per suite SEGFAULTS the batched runner.
 *  - DB-free: no Postgres — InMemoryStore is the fallback when no dataProvider.
 *
 * Design:
 *  - Entity `order` — the triggering record.
 *  - Entity `fulfilment` — an observable marker written ONLY by the flow's step.
 *  - Action `record_fulfilment` — the flow's step action; creates a `fulfilment`
 *    row. Tolerant of whatever input it receives.
 *  - Flow `order_fulfilment` — one action step that runs `record_fulfilment`.
 *  - Rule `fulfil_on_submit` — on `submit_order`, `trigger_flow` → `order_fulfilment`.
 *
 * The post-commit rule-effects runner is awaited and the SyncFlowEngine runs
 * synchronously, so the flow completes before the submit response returns. We
 * then query `fulfilment` and assert a row exists — proving the flow ran.
 */

import { describe, expect, test } from "bun:test";
import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  FlowDefinition,
  RuleDefinition,
} from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { capAdapterServer } from "../src/capability";
import { createDevApp } from "../src/dev-app";

// ── Entities ────────────────────────────────────────────────────────────────

const orderEntity: EntityDefinition = {
  name: "order",
  label: "Order",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    status: { type: "string", default: "draft", label: "Status" },
  },
};

// Observable marker written ONLY by the flow's step action. A row here proves
// the `trigger_flow` rule effect started the flow and its step executed.
const fulfilmentEntity: EntityDefinition = {
  name: "fulfilment",
  label: "Fulfilment",
  fields: {
    sourceOrderId: { type: "string", label: "Source Order ID" },
    note: { type: "string", label: "Note" },
  },
};

// Observable marker written by the DOWNSTREAM flow reached via an `onComplete`
// chain. A row here proves the in-process engine resolved the chain — which only
// works when `createRuntimeContext` builds + passes a FlowRegistry to the sync
// engine (the hardening this suite guards). Without it, the chain silently no-ops.
const notificationEntity: EntityDefinition = {
  name: "notification",
  label: "Notification",
  fields: {
    message: { type: "string", label: "Message" },
  },
};

// ── Action: the flow's step ─────────────────────────────────────────────────

/**
 * record_fulfilment: the flow's single step. Creates a `fulfilment` row — the
 * observable side effect. Tolerant of whatever input the flow passes; it derives
 * `sourceOrderId` from the flow input (`$input.id`, mapped in the flow step) but
 * falls back gracefully so the flow demonstrably runs regardless of mapping.
 */
const recordFulfilmentAction: ActionDefinition = {
  name: "record_fulfilment",
  entity: "fulfilment",
  label: "Record Fulfilment",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const sourceOrderId = (ctx.input.sourceOrderId as string | undefined) ?? "unknown";
    return ctx.create("fulfilment", { sourceOrderId, note: "fulfilled-by-flow" });
  },
};

/**
 * notify_fulfilment: the downstream flow's step, reached via the
 * `order_fulfilment` flow's `onComplete` chain. Writes a `notification` row —
 * proving the in-process engine resolved the chain.
 */
const notifyFulfilmentAction: ActionDefinition = {
  name: "notify_fulfilment",
  entity: "notification",
  label: "Notify Fulfilment",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    return ctx.create("notification", { message: "fulfilment-completed" });
  },
};

// ── Action: the triggering action ───────────────────────────────────────────

/**
 * submit_order: writes status = "submitted". The `fulfil_on_submit` rule fires a
 * `trigger_flow` effect post-commit, starting `order_fulfilment`.
 */
const submitOrderAction: ActionDefinition = {
  name: "submit_order",
  entity: "order",
  label: "Submit Order",
  policy: { mode: "sync", transaction: false },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    return ctx.update("order", id, { status: "submitted" });
  },
};

// ── Flow ────────────────────────────────────────────────────────────────────

/**
 * order_fulfilment: a single action step. The rule path calls `startFlow`
 * directly with the triggering action's effective input (`{ id: <orderId> }`),
 * so `$input.id` resolves to the submitted order's id — proving flow input flows
 * through to the step action.
 */
const orderFulfilmentFlow: FlowDefinition = {
  name: "order_fulfilment",
  label: "Order Fulfilment",
  trigger: { type: "manual" },
  steps: [
    {
      id: "fulfil",
      name: "Record Fulfilment",
      type: "action",
      actionName: "record_fulfilment",
      input: { sourceOrderId: "$input.id" },
    },
  ],
  // On completion, chain to the downstream flow. This resolves ONLY when the
  // sync engine was built with a FlowRegistry (the codex-flagged hardening).
  onComplete: { flow: "post_fulfilment" },
};

/**
 * post_fulfilment: the downstream flow reached via `order_fulfilment.onComplete`.
 * One action step writing a `notification` row.
 */
const postFulfilmentFlow: FlowDefinition = {
  name: "post_fulfilment",
  label: "Post Fulfilment",
  trigger: { type: "manual" },
  steps: [
    {
      id: "notify",
      name: "Notify Fulfilment",
      type: "action",
      actionName: "notify_fulfilment",
    },
  ],
};

// ── Rule ────────────────────────────────────────────────────────────────────

/**
 * fulfil_on_submit: on every submit_order, start the order_fulfilment flow as a
 * post-commit side effect. No condition narrowing — fires for every submission.
 */
const fulfilOnSubmitRule: RuleDefinition = {
  name: "fulfil_on_submit",
  label: "Fulfil on Submit",
  description: "Start the order_fulfilment flow after an order is submitted",
  trigger: { action: "submit_order" },
  effect: { type: "trigger_flow", flow: "order_fulfilment" },
};

// ── Business capability ─────────────────────────────────────────────────────

const capTriggerFlowBiz: CapabilityDefinition = defineCapability({
  name: "cap-trigger-flow-biz",
  label: "Trigger Flow Business",
  description: "Synthetic business capability: an order whose submit triggers a fulfilment flow",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [orderEntity, fulfilmentEntity, notificationEntity],
  actions: [submitOrderAction, recordFulfilmentAction, notifyFulfilmentAction],
  rules: [fulfilOnSubmitRule],
  flows: [orderFulfilmentFlow, postFulfilmentFlow],
});

// ── Request helpers (in-process, port-free) ─────────────────────────────────

const BASE_URL = "http://local.test";

async function postAction(
  app: ReturnType<typeof createDevApp>["app"],
  name: string,
  input: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.handle(
    new Request(`${BASE_URL}/api/actions/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function gql(
  app: ReturnType<typeof createDevApp>["app"],
  query: string,
): Promise<{ data: Record<string, unknown>; errors?: Array<{ message: string }> }> {
  const res = await app.handle(
    new Request(`${BASE_URL}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
    }),
  );
  return res.json() as Promise<{
    data: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  }>;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("E2E rule effect: trigger_flow (in-process, DB-free, port-free)", () => {
  test("1. submit_order triggers order_fulfilment flow → a fulfilment row is written", async () => {
    const { app } = createDevApp([capAdapterServer, capTriggerFlowBiz], { cors: false });

    // Create an order via the auto-generated CRUD action.
    const created = await postAction(app, "create_order", { title: "Widget Order" });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    const orderId = (created.body.data as Record<string, unknown>).id as string;
    expect(orderId).toBeTruthy();

    // Sanity: no fulfilment exists before the flow runs.
    const before = await gql(app, `query { fulfilmentList { items { id } } }`);
    expect(before.errors).toBeUndefined();
    const beforeItems = (before.data.fulfilmentList as Record<string, unknown>).items as unknown[];
    expect(beforeItems).toHaveLength(0);

    // Submit — the fulfil_on_submit rule fires a trigger_flow effect post-commit.
    // The SyncFlowEngine runs synchronously, so the flow completes before this
    // response returns.
    const submit = await postAction(app, "submit_order", { id: orderId });
    expect(submit.status).toBe(200);
    expect(submit.body.success).toBe(true);

    // The primary write happened.
    const orderGql = await gql(app, `query { order(id: "${orderId}") { id status } }`);
    expect(orderGql.errors).toBeUndefined();
    expect((orderGql.data.order as Record<string, unknown>).status).toBe("submitted");

    // The flow ran: its step action created a fulfilment row.
    const after = await gql(app, `query { fulfilmentList { items { id sourceOrderId note } } }`);
    expect(after.errors).toBeUndefined();
    const items = (after.data.fulfilmentList as Record<string, unknown>).items as Array<
      Record<string, unknown>
    >;
    expect(items).toHaveLength(1);
    expect(items[0].note).toBe("fulfilled-by-flow");
    // The flow input ($input.id) flowed through to the step action.
    expect(items[0].sourceOrderId).toBe(orderId);

    // The onComplete chain reached the downstream flow: a notification row exists.
    // This only happens because createRuntimeContext built + passed a FlowRegistry
    // to the sync engine — without it, the chain silently no-ops.
    const notified = await gql(app, `query { notificationList { items { id message } } }`);
    expect(notified.errors).toBeUndefined();
    const notifications = (notified.data.notificationList as Record<string, unknown>)
      .items as Array<Record<string, unknown>>;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe("fulfilment-completed");
  });

  test("2. a submit with no triggering flow does NOT write a fulfilment row", async () => {
    // Fresh app = fresh in-memory store, fully isolated from test 1.
    const { app } = createDevApp([capAdapterServer, capTriggerFlowBiz], { cors: false });

    // Create an order but never submit it — the rule (and thus the flow) never fires.
    const created = await postAction(app, "create_order", { title: "Unsubmitted Order" });
    expect(created.status).toBe(200);

    const res = await gql(app, `query { fulfilmentList { items { id } } }`);
    expect(res.errors).toBeUndefined();
    const items = (res.data.fulfilmentList as Record<string, unknown>).items as unknown[];
    // No submit → no trigger_flow → no fulfilment row.
    expect(items).toHaveLength(0);
  });
});
