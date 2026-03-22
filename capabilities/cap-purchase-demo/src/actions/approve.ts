/**
 * Approve purchase request action
 */

import type { ActionDefinition } from "@linchkit/core";

export const approveAction: ActionDefinition = {
  name: "approve_purchase_request",
  schema: "purchase_request",
  label: "Approve Purchase Request",
  description: "Approve a pending purchase request",
  permissions: { groups: ["admin", "manager"] },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "pending") {
      throw new Error(`Cannot approve: current status is "${record.status}", expected "pending"`);
    }
    return ctx.update("purchase_request", id, {
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: ctx.actor.id,
    });
  },
};
