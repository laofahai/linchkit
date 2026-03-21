import { describe, expect, it } from "bun:test";
import {
  defineAction,
  defineCapability,
  defineEventHandler,
  defineRule,
  defineSchema,
  defineState,
  defineView,
} from "../src";

describe("defineSchema", () => {
  it("should return schema definition with fields", () => {
    const schema = defineSchema({
      name: "purchase_request",
      label: "采购申请",
      fields: {
        title: { type: "string", required: true, label: "标题" },
        amount: { type: "number", required: true, min: 0, label: "金额" },
        department: { type: "ref", target: "department", required: true, label: "部门" },
        status: { type: "state", machine: "request_lifecycle", label: "状态" },
        items: { type: "has_many", target: "purchase_item", label: "明细" },
      },
    });

    expect(schema.name).toBe("purchase_request");
    expect(schema.fields.title.type).toBe("string");
    expect(schema.fields.amount.type).toBe("number");
    expect(schema.fields.department.type).toBe("ref");
    expect(schema.fields.status.type).toBe("state");
    expect(schema.fields.items.type).toBe("has_many");
  });

  it("should support exposure config", () => {
    const schema = defineSchema({
      name: "employee",
      fields: {
        name: { type: "string" },
        salary: { type: "number", sensitive: true },
      },
      exposure: { graphql: true, mcp: true },
      fieldExposure: {
        salary: { graphql: true, mcp: false },
      },
    });

    expect(schema.exposure?.graphql).toBe(true);
    expect(schema.fieldExposure?.salary?.mcp).toBe(false);
  });
});

describe("defineAction", () => {
  it("should return declarative action definition", () => {
    const action = defineAction({
      name: "submit_request",
      schema: "purchase_request",
      label: "提交采购申请",
      input: {
        id: { type: "ref", target: "purchase_request", required: true },
      },
      stateTransition: { from: "draft", to: "submitted" },
      policy: { mode: "sync", transaction: true },
    });

    expect(action.name).toBe("submit_request");
    expect(action.stateTransition?.from).toBe("draft");
    expect(action.stateTransition?.to).toBe("submitted");
    expect(action.policy.mode).toBe("sync");
  });

  it("should support handler-based action", () => {
    const action = defineAction({
      name: "calculate_total",
      schema: "purchase_request",
      label: "计算总额",
      input: {
        id: { type: "ref", target: "purchase_request", required: true },
      },
      handler: async (ctx) => {
        const items = await ctx.query("purchase_item", { request_id: ctx.input.id });
        return { total: items.length };
      },
      policy: { mode: "sync", transaction: true },
    });

    expect(action.name).toBe("calculate_total");
    expect(action.handler).toBeDefined();
  });
});

describe("defineRule", () => {
  it("should return declarative rule with simple condition", () => {
    const rule = defineRule({
      name: "amount_check",
      label: "大额采购需审批",
      trigger: { action: "submit_request" },
      condition: {
        field: "target.amount",
        operator: "gt",
        value: 10000,
      },
      effect: {
        type: "require_approval",
        level: "director",
        message: "采购金额超过10000，需要总监审批",
      },
    });

    expect(rule.name).toBe("amount_check");
    expect(rule.effect.type).toBe("require_approval");
  });

  it("should support composite conditions", () => {
    const rule = defineRule({
      name: "combined_check",
      label: "组合条件",
      trigger: { action: "submit_request" },
      condition: {
        operator: "and",
        conditions: [
          { field: "target.amount", operator: "gt", value: 10000 },
          { field: "target.department.name", operator: "eq", value: "销售部" },
        ],
      },
      effect: { type: "block", message: "不允许" },
    });

    expect(rule.name).toBe("combined_check");
    expect(rule.effect.type).toBe("block");
  });

  it("should support code-based condition", () => {
    const rule = defineRule({
      name: "complex_check",
      label: "复杂规则",
      trigger: { action: "submit_request" },
      condition: ({ target }) => {
        return (target.amount as number) > 50000;
      },
      effect: { type: "block", message: "超额" },
    });

    expect(typeof rule.condition).toBe("function");
  });
});

describe("defineState", () => {
  it("should return state machine definition", () => {
    const state = defineState({
      name: "request_lifecycle",
      schema: "purchase_request",
      field: "status",
      initial: "draft",
      states: ["draft", "submitted", "approved", "rejected", "cancelled"],
      transitions: [
        { from: "draft", to: "submitted", action: "submit_request" },
        { from: "submitted", to: "approved", action: "approve_request" },
        { from: "submitted", to: "rejected", action: "reject_request" },
        { from: ["draft", "submitted"], to: "cancelled", action: "cancel_request" },
      ],
      meta: {
        draft: { label: "草稿", color: "gray" },
        submitted: { label: "已提交", color: "blue" },
        approved: { label: "已批准", color: "green" },
      },
    });

    expect(state.name).toBe("request_lifecycle");
    expect(state.initial).toBe("draft");
    expect(state.states).toHaveLength(5);
    expect(state.transitions).toHaveLength(4);
  });
});

describe("defineView", () => {
  it("should return view definition", () => {
    const view = defineView({
      name: "purchase_request_list",
      schema: "purchase_request",
      type: "list",
      label: "采购申请列表",
      fields: [
        { field: "title", sortable: true },
        { field: "amount", sortable: true, filterable: true },
        { field: "status", filterable: true },
        { field: "department" },
      ],
      actions: [{ action: "submit_request", label: "提交", position: "row" }],
      defaultSort: { field: "created_at", order: "desc" },
      pageSize: 20,
    });

    expect(view.name).toBe("purchase_request_list");
    expect(view.type).toBe("list");
    expect(view.fields).toHaveLength(4);
  });
});

describe("defineEventHandler", () => {
  it("should return event handler definition", () => {
    const handler = defineEventHandler({
      name: "notify_on_approval",
      label: "审批后通知",
      listen: "action.succeeded",
      filter: { action: "approve_request" },
      async: true,
      handler: async (event, ctx) => {
        await ctx.execute("send_notification", {
          to: event.payload.requester,
          template: "request_approved",
        });
      },
    });

    expect(handler.name).toBe("notify_on_approval");
    expect(handler.async).toBe(true);
  });
});

describe("defineCapability", () => {
  it("should compose schemas, actions, rules, states, views", () => {
    const cap = defineCapability({
      name: "purchase_management",
      label: "采购管理",
      type: "standard",
      category: "business",
      version: "1.0.0",
      schemas: [
        defineSchema({
          name: "purchase_request",
          fields: { title: { type: "string" } },
        }),
      ],
      actions: [
        defineAction({
          name: "submit_request",
          schema: "purchase_request",
          label: "提交",
          policy: { mode: "sync", transaction: true },
        }),
      ],
      rules: [
        defineRule({
          name: "amount_check",
          label: "金额检查",
          trigger: { action: "submit_request" },
          condition: { field: "target.amount", operator: "gt", value: 10000 },
          effect: { type: "warn", message: "大额采购" },
        }),
      ],
    });

    expect(cap.name).toBe("purchase_management");
    expect(cap.type).toBe("standard");
    expect(cap.schemas).toHaveLength(1);
    expect(cap.actions).toHaveLength(1);
    expect(cap.rules).toHaveLength(1);
  });
});
