/**
 * Generate default CRUD action definitions for a EntityDefinition.
 *
 * Extracted from build-schema.ts to keep each module focused on a single concern.
 */

import type {
  ActionDefinition,
  DerivedPropertyEngine,
  EntityDefinition,
  StateDefinition,
} from "@linchkit/core";
import { createStateMachine, getAvailableTransitions } from "@linchkit/core/server";

/** Options for CRUD action generation */
export interface GenerateCrudActionsOptions {
  /** Derived property engine for auto-computing store-strategy derived fields */
  derivedPropertyEngine?: DerivedPropertyEngine;
  /** State definitions for validating state field changes via transitions */
  stateDefinitions?: StateDefinition[];
}

/**
 * Generate default CRUD action definitions for a schema.
 */
export function generateCrudActions(
  schema: EntityDefinition,
  options?: GenerateCrudActionsOptions,
): ActionDefinition[] {
  const name = schema.name;
  const derivedEngine = options?.derivedPropertyEngine;
  const stateDefinitions = options?.stateDefinitions ?? [];

  // Build a map of state field name → StateMachine for this schema
  const stateFieldMachines = new Map<string, ReturnType<typeof createStateMachine>>();
  for (const [fieldName, field] of Object.entries(schema.fields)) {
    if (field.type === "state") {
      const stateDef = stateDefinitions.find((s) => s.name === field.machine);
      if (stateDef) {
        stateFieldMachines.set(fieldName, createStateMachine(stateDef));
      }
    }
  }

  const createAction: ActionDefinition = {
    name: `create_${name}`,
    schema: name,
    label: `Create ${schema.label ?? name}`,
    description: `Create a new ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      // Inject default state values for state fields not provided in input
      const inputWithDefaults = { ...ctx.input };
      for (const [fieldName, field] of Object.entries(schema.fields)) {
        if (field.type === "state" && inputWithDefaults[fieldName] === undefined) {
          if (field.default !== undefined) {
            inputWithDefaults[fieldName] = field.default;
          }
        }
      }
      // Compute store-strategy derived fields before persisting
      if (derivedEngine) {
        try {
          // Use async version to support aggregate computations
          const derivedValues = await derivedEngine.computeStoreFieldsAsync(
            name,
            inputWithDefaults,
          );
          Object.assign(inputWithDefaults, derivedValues);
        } catch (err) {
          throw new Error(
            `Derived field computation failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const result = await ctx.create(name, inputWithDefaults);
      ctx.emit("record.created", {
        schema: name,
        recordId: result.id as string,
        ...result,
      });
      // Cascade recalculate parent aggregate fields if this child schema affects any
      if (derivedEngine?.hasCascadeTargets(name)) {
        try {
          await derivedEngine.cascadeRecalculate(name, result);
        } catch {
          // Cascade failures are non-fatal — log but don't fail the create
        }
      }
      return result;
    },
  };

  const updateAction: ActionDefinition = {
    name: `update_${name}`,
    schema: name,
    label: `Update ${schema.label ?? name}`,
    description: `Update an existing ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const id = ctx.input.id as string;
      const { id: _id, ...data } = ctx.input;

      // Fetch existing record once — used for state validation, derived fields, and change diff
      let before: Record<string, unknown>;
      try {
        before = await ctx.get(name, id);
      } catch (err) {
        if (err instanceof Error && err.message.includes("not found")) {
          before = {};
        } else {
          throw err;
        }
      }

      // Validate state field transitions: reject direct state changes that bypass the state machine
      if (stateFieldMachines.size > 0) {
        for (const [fieldName, machine] of stateFieldMachines) {
          const newValue = data[fieldName] as string | undefined;
          if (newValue === undefined || newValue === null) continue;
          const currentValue = before[fieldName] as string | undefined;
          if (currentValue === newValue) continue;
          // Check if the target state is reachable from the current state via any transition
          const available = getAvailableTransitions(machine, currentValue ?? "");
          const isReachable = available.some((t) => t.to === newValue);
          if (!isReachable) {
            throw new Error(
              `State transition not allowed: cannot change "${fieldName}" from "${currentValue}" to "${newValue}". Use a dedicated transition action.`,
            );
          }
        }
      }

      // Compute store-strategy derived fields before persisting.
      // Merge existing record with new data so derived expressions can access all fields.
      if (derivedEngine) {
        const fullRecord = { ...before, ...data };
        try {
          // Use async version to support aggregate computations
          const derivedValues = await derivedEngine.computeStoreFieldsAsync(name, fullRecord);
          Object.assign(data, derivedValues);
        } catch (err) {
          throw new Error(
            `Derived field computation failed for ${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const result = await ctx.update(name, id, data);

      // Emit record.updated with before/after diff for Chatter auto-audit and subscriptions
      const changedFields = Object.keys(data).filter(
        (k) => before[k] !== (result as Record<string, unknown>)[k],
      );
      ctx.emit("record.updated", {
        schema: name,
        recordId: id,
        _old: before,
        _new: result,
        changedFields,
      });

      // Cascade recalculate parent aggregate fields if this child schema affects any
      if (derivedEngine?.hasCascadeTargets(name)) {
        try {
          await derivedEngine.cascadeRecalculate(name, result);
        } catch {
          // Cascade failures are non-fatal — log but don't fail the update
        }
      }
      return result;
    },
  };

  const deleteAction: ActionDefinition = {
    name: `delete_${name}`,
    schema: name,
    label: `Delete ${schema.label ?? name}`,
    description: `Delete a ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const id = ctx.input.id as string;
      // Capture the record before deletion for cascade recalculation
      let deletedRecord: Record<string, unknown> | undefined;
      if (derivedEngine?.hasCascadeTargets(name)) {
        try {
          deletedRecord = await ctx.get(name, id);
        } catch {
          // Record may not exist — skip cascade
        }
      }
      await ctx.delete(name, id);
      ctx.emit("record.deleted", {
        schema: name,
        recordId: id,
        id,
      });
      // Cascade recalculate parent aggregate fields after delete
      if (derivedEngine && deletedRecord) {
        try {
          await derivedEngine.cascadeRecalculate(name, deletedRecord);
        } catch {
          // Cascade failures are non-fatal
        }
      }
      return { deleted: true, id };
    },
  };

  const restoreAction: ActionDefinition = {
    name: `restore_${name}`,
    schema: name,
    label: `Restore ${schema.label ?? name}`,
    description: `Restore a soft-deleted ${schema.label ?? name} record`,
    policy: { mode: "sync", transaction: true },
    exposure: "all",
    handler: async (ctx) => {
      const id = ctx.input.id as string;
      // Restore needs to see soft-deleted records; override queryOptions
      const record = await ctx.get(name, id, { includeDeleted: true });
      if (!record) {
        throw new Error(`Record "${id}" not found in "${name}"`);
      }
      if (record.deleted_at == null) {
        // Record is not deleted — return it as-is
        return record;
      }
      // Clear deleted_at to restore the record
      const result = await ctx.update(name, id, { deleted_at: null });
      // Cascade recalculate parent aggregate fields after restore
      if (derivedEngine?.hasCascadeTargets(name)) {
        try {
          await derivedEngine.cascadeRecalculate(name, result);
        } catch {
          // Cascade failures are non-fatal
        }
      }
      return result;
    },
  };

  return [createAction, updateAction, deleteAction, restoreAction];
}
