/**
 * Shared test helpers for Spec 63 field-lock tests.
 */

import { createActionExecutor, type DataProvider } from "../src/engine/action-engine";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { ActionDefinition, Actor } from "../src/types/action";
import type { EntityDefinition } from "../src/types/entity";

export const lockActor: Actor = { type: "human", id: "user-1", groups: ["admin"] };

/** Minimal in-memory DataProvider supporting get/query/create/update/delete/count. */
export function createMemoryDataProvider(): DataProvider {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  function getTable(schema: string): Map<string, Record<string, unknown>> {
    let table = store.get(schema);
    if (!table) {
      table = new Map();
      store.set(schema, table);
    }
    return table;
  }
  return {
    async get(schema, id) {
      const record = getTable(schema).get(id);
      if (!record) throw new Error(`Record not found: ${schema}/${id}`);
      return record;
    },
    async query(schema, filter) {
      return Array.from(getTable(schema).values()).filter((r) =>
        Object.entries(filter).every(([k, v]) => r[k] === v),
      );
    },
    async create(schema, data) {
      const table = getTable(schema);
      const id = (data.id as string) || `id_${table.size + 1}`;
      const record = { ...data, id };
      table.set(id, record);
      return record;
    },
    async update(schema, id, data) {
      const table = getTable(schema);
      const existing = table.get(id);
      if (!existing) throw new Error(`Record not found: ${schema}/${id}`);
      const updated = { ...existing, ...data };
      table.set(id, updated);
      return updated;
    },
    async delete(schema, id) {
      getTable(schema).delete(id);
    },
    async count(schema, filter) {
      const records = Array.from(getTable(schema).values());
      if (!filter) return records.length;
      return records.filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v)).length;
    },
  };
}

/**
 * Build an ActionExecutor preloaded with a generic `update_record` action
 * that writes `ctx.input` (minus `id`) onto the target record. Use this to
 * drive field-lock checks end-to-end through the engine pipeline.
 */
export function setupLockHarness(entity: EntityDefinition) {
  const entityRegistry = createEntityRegistry();
  entityRegistry.register(entity);
  const dataProvider = createMemoryDataProvider();
  const executor = createActionExecutor({ dataProvider, entityRegistry });

  const updateAction: ActionDefinition = {
    name: "update_record",
    entity: entity.name,
    label: "Update Record",
    input: { id: { type: "string", required: true } },
    policy: { mode: "sync", transaction: false },
    handler: async (ctx) => {
      const recordId = ctx.input.id as string;
      const { id: _id, ...rest } = ctx.input as Record<string, unknown>;
      return ctx.update(entity.name, recordId, rest);
    },
  };
  executor.registry.register(updateAction);

  return { executor, dataProvider, entityRegistry };
}
