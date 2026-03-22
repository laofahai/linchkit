/**
 * Shared test helpers for Command Layer tests.
 */

import { type ActionExecutor, createActionExecutor } from "../src/engine/action-engine";
import { type CommandLayer, createCommandLayer } from "../src/engine/command-layer";
import type { ActionDefinition } from "../src/types/action";

/** Minimal in-memory data provider */
export function createTestDataProvider() {
  const data = new Map<string, Map<string, Record<string, unknown>>>();
  let counter = 0;

  return {
    async get(schema: string, id: string) {
      const table = data.get(schema);
      const record = table?.get(id);
      if (!record) throw new Error(`Record ${schema}/${id} not found`);
      return record;
    },
    async query(_schema: string, _filter: Record<string, unknown>) {
      return [];
    },
    async create(schema: string, input: Record<string, unknown>) {
      if (!data.has(schema)) data.set(schema, new Map());
      counter++;
      const id = `test_${counter}`;
      const record = {
        id,
        ...input,
        _version: 1,
        tenant_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const table = data.get(schema);
      if (!table) throw new Error(`Unreachable: data missing key ${schema}`);
      table.set(id, record);
      return record;
    },
    async update(schema: string, id: string, updates: Record<string, unknown>) {
      const table = data.get(schema);
      const record = table?.get(id);
      if (!record) throw new Error(`Record ${schema}/${id} not found`);
      Object.assign(record, updates);
      return record;
    },
    async delete(schema: string, id: string) {
      data.get(schema)?.delete(id);
    },
  };
}

export interface TestSetupOptions {
  /** Optional verifyApproval callback for CommandLayer */
  verifyApproval?: (approvalId: string) => Promise<boolean>;
}

/** Create a test action executor with common test actions */
export function createTestSetup(opts?: TestSetupOptions): { executor: ActionExecutor; layer: CommandLayer } {
  const dp = createTestDataProvider();
  const executor = createActionExecutor({ dataProvider: dp });

  const testAction: ActionDefinition = {
    name: "create_item",
    schema: "item",
    label: "Create Item",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    handler: async (ctx) => {
      return ctx.create("item", ctx.input);
    },
  };
  executor.registry.register(testAction);

  const internalAction: ActionDefinition = {
    name: "internal_only",
    schema: "item",
    label: "Internal Only",
    policy: { mode: "sync", transaction: false },
    exposure: { http: false, mcp: false, cli: false, ui: false, internal: true },
    handler: async () => {
      return { done: true };
    },
  };
  executor.registry.register(internalAction);

  const adminAction: ActionDefinition = {
    name: "admin_action",
    schema: "item",
    label: "Admin Action",
    policy: { mode: "sync", transaction: false },
    exposure: "all",
    permissions: { groups: ["admin"] },
    handler: async () => {
      return { admin: true };
    },
  };
  executor.registry.register(adminAction);

  const layer = createCommandLayer({ executor, verifyApproval: opts?.verifyApproval });
  return { executor, layer };
}
