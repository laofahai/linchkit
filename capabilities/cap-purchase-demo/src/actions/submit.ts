/**
 * Submit purchase request action
 */

import type { ActionDefinition } from "@linchkit/core";

export const submitAction: ActionDefinition = {
  name: "submit_purchase_request",
  schema: "purchase_request",
  label: "Submit Purchase Request",
  description: "Submit a draft purchase request for approval",
  input: {
    notes: { type: "text", label: "Submission Notes" },
  },
  permissions: { groups: ["admin", "manager", "user"] },
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  handler: async (ctx) => {
    const id = ctx.input.id as string;
    const record = await ctx.get("purchase_request", id);
    if (record.status !== "draft") {
      throw new Error(`Cannot submit: current status is "${record.status}", expected "draft"`);
    }
    return ctx.update("purchase_request", id, {
      status: "pending",
      submitted_at: new Date().toISOString(),
    });
  },
};
