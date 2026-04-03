/**
 * Schema form page — action execution logic extracted as a custom hook.
 *
 * Handles: submit (create/update), cancel, business action execution,
 * state transitions, delete, and clone source fetching.
 */

import type { EntityDefinition } from "@linchkit/core/types";
import { toast } from "@linchkit/ui-kit/components";
import type { NavigateOptions } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import type { TFunction } from "i18next";
import type { EnrichedSubmitData } from "../components/auto-form/types";
import type { StateTransitionInfo } from "../components/status-bar";
import type { ResolvedSchemaBundle } from "../hooks/use-entity-bundle";
import { pushNotification } from "../hooks/use-notifications";
import {
  createRecord,
  deleteRecord,
  executeAction,
  queryRecord,
  queryStateTransitions,
  transitionRecord,
  updateRecord,
} from "../lib/api";
import {
  CLONE_STRIP_FIELDS,
  getMutationReturnFields,
} from "../lib/entity-form-utils";

/** Transition descriptor from useTransitionPermissions */
export interface TransitionInfo {
  action: string;
  to: string;
}

export interface UseFormActionsOptions {
  schemaName: string | undefined;
  recordId: string | undefined;
  isCreate: boolean;
  schema: EntityDefinition | undefined;
  bundle: ResolvedSchemaBundle | undefined;
  recordFields: string[];
  recordFieldsRef: React.RefObject<string[]>;
  availableTransitions: TransitionInfo[];
  navigate: (opts: NavigateOptions) => void;
  fetchRecord: () => Promise<void>;
  refetchTransitions: () => Promise<void>;
  t: TFunction;
}

export function useFormActions(opts: UseFormActionsOptions) {
  const {
    schemaName,
    recordId,
    isCreate,
    schema,
    bundle,
    recordFields,
    recordFieldsRef,
    availableTransitions,
    navigate,
    fetchRecord,
    refetchTransitions,
    t,
  } = opts;

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  /** Prepare mutation input by stripping non-input fields and converting ref values to FK columns. */
  function prepareMutationInput(data: Record<string, unknown>): Record<string, unknown> {
    if (!schema) return data;
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const fieldDef = schema.fields[key];
      if (!fieldDef) continue;
      // Skip derived fields — they are computed, not user input
      if (fieldDef.derived) continue;
      // Convert ref field values to FK column format (e.g., department -> department_id)
      if (fieldDef.type === "ref") {
        const target = (fieldDef as { target?: string }).target;
        if (target) {
          // Check bundle.links for actual FK column name, fall back to convention
          const link = bundle?.links?.find(
            (l) =>
              (l.from === schemaName &&
                l.to === target &&
                (l.cardinality === "many_to_one" || l.cardinality === "one_to_one")) ||
              (l.to === schemaName && l.from === target && l.cardinality === "one_to_many"),
          );
          const fkKey = link
            ? link.from === schemaName
              ? `${link.to}_id`
              : `${link.from}_id`
            : `${target}_id`;
          // Extract ID from expanded object or use raw value
          const refValue =
            typeof value === "object" && value !== null && "id" in value
              ? (value as { id: string }).id
              : value;
          // Only send if the value is not empty
          if (refValue != null && refValue !== "") {
            input[fkKey] = refValue;
          }
        }
        continue;
      }
      // Skip has_many and many_to_many — they are managed via junction tables, not direct input
      if (fieldDef.type === "has_many" || fieldDef.type === "many_to_many") continue;
      input[key] = value;
    }
    return input;
  }

  const handleSubmit = useCallback(
    async (
      data: Record<string, unknown>,
      enriched?: EnrichedSubmitData,
    ): Promise<undefined> => {
      if (!schemaName) return;
      setSaving(true);
      try {
        // Step 1: Create virtual ref records first (quick-created related records)
        const virtualRefIdMap = new Map<string, string>(); // tempId -> real ID
        if (enriched?.virtualRefs) {
          for (const [fieldName, virtualRecord] of Object.entries(enriched.virtualRefs)) {
            const fieldDef = schema?.fields[fieldName];
            if (!fieldDef || fieldDef.type !== "ref") continue;
            const targetSchema = (fieldDef as { target?: string }).target;
            if (!targetSchema) continue;

            // Build input from virtual record, stripping internal fields
            const refInput: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(virtualRecord)) {
              if (key === "_virtual" || key === "_tempId" || key === "id") continue;
              refInput[key] = val;
            }

            const created = await createRecord<{ id: string }>(targetSchema, refInput, ["id"]);
            virtualRefIdMap.set(virtualRecord._tempId, created.id);
          }
        }

        // Step 2: Prepare mutation input, replacing virtual ref IDs with real ones
        const mutationData = { ...data };
        for (const [fieldName, virtualRecord] of Object.entries(enriched?.virtualRefs ?? {})) {
          const realId = virtualRefIdMap.get(virtualRecord._tempId);
          if (realId) {
            mutationData[fieldName] = realId;
          }
        }

        const mutationInput = prepareMutationInput(mutationData);

        // Step 3: Create/update parent record
        // Filter out has_many/many_to_many fields — they exist on query types but not mutation return types
        const mutationReturnFields = getMutationReturnFields(recordFields, schema);
        let parentRecordId = recordId;
        if (isCreate) {
          const created = await createRecord<{ id: string }>(schemaName, mutationInput, [
            "id",
            ...mutationReturnFields,
          ]);
          parentRecordId = created.id;
        } else if (parentRecordId) {
          await updateRecord(schemaName, parentRecordId, mutationInput, mutationReturnFields);
        }

        // Step 4: Process child commands (has_many inline records)
        if (enriched?.childCommands && parentRecordId) {
          for (const [fieldName, commands] of Object.entries(enriched.childCommands)) {
            const fieldDef = schema?.fields[fieldName];
            if (!fieldDef || fieldDef.type !== "has_many") continue;
            const targetSchema = (fieldDef as { target?: string }).target;
            if (!targetSchema) continue;

            // Find the FK column name from links
            const _link = bundle?.links?.find(
              (l) =>
                (l.cardinality === "one_to_many" && l.from === schemaName && l.to === targetSchema) ||
                (l.cardinality === "many_to_one" && l.to === schemaName && l.from === targetSchema),
            );
            const fkColumn = `${schemaName}_id`;

            for (const cmd of commands) {
              switch (cmd.type) {
                case "create": {
                  const childInput = { ...cmd.values, [fkColumn]: parentRecordId };
                  await createRecord(targetSchema, childInput, ["id"]);
                  break;
                }
                case "update": {
                  await updateRecord(targetSchema, cmd.id, cmd.values, ["id"]);
                  break;
                }
                case "delete": {
                  await deleteRecord(targetSchema, cmd.id);
                  break;
                }
              }
            }
          }
        }

        if (isCreate) {
          toast.success(t("toast.recordCreated", "Record created successfully"));
          navigate({ to: "/schemas/$name", params: { name: schemaName } });
        } else {
          toast.success(t("toast.recordUpdated", "Record updated successfully"));
          await fetchRecord();
          return undefined; // signal success — caller sets formMode
        }
      } catch (err) {
        const msg = isCreate
          ? t("toast.createFailed", "Failed to create record")
          : t("toast.updateFailed", "Failed to update record");
        toast.error(msg);
        // Re-throw so AutoForm's built-in server error parser handles display
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [schemaName, recordId, isCreate, schema, bundle?.links, recordFields, navigate, fetchRecord, t],
  );

  const handleAction = useCallback(
    async (actionName: string): Promise<Record<string, unknown> | undefined> => {
      setSaving(true);
      try {
        if (!recordId) return;

        // If it's a transition action, use transitionRecord instead of executeAction
        const transition = availableTransitions.find((tr) => tr.action === actionName);
        if (transition) {
          const updated = await transitionRecord(
            schemaName ?? "",
            recordId,
            transition.to,
            recordFields,
          );
          toast.success(t("toast.transitionSuccess", "Status changed successfully"));
          return updated as Record<string, unknown>;
        }

        const result = await executeAction(actionName, { id: recordId });
        if (result.success) {
          toast.success(t("toast.actionSuccess", "Action executed successfully"));
          pushNotification({
            type: "action_success",
            message: t("notifications.actionSucceeded", { action: actionName }),
            schema: schemaName,
            recordId,
          });
          await fetchRecord();
        } else {
          toast.error(t("toast.actionFailed", "Action failed"));
          pushNotification({
            type: "action_failure",
            message: t("notifications.actionFailed", { action: actionName }),
            schema: schemaName,
            recordId,
          });
        }
        return undefined;
      } catch (_err) {
        toast.error(t("toast.actionFailed", "Action failed"));
        pushNotification({
          type: "action_failure",
          message: t("notifications.actionFailed", { action: actionName }),
          schema: schemaName,
        });
        return undefined;
      } finally {
        setSaving(false);
      }
    },
    [recordId, schemaName, availableTransitions, recordFields, fetchRecord, refetchTransitions, t],
  );

  const executeDeleteAction = useCallback(async () => {
    if (!schemaName || !recordId) return;
    setDeleting(true);
    try {
      await deleteRecord(schemaName, recordId);
      toast.success(t("toast.recordDeleted", "Record deleted successfully"));
      navigate({ to: "/schemas/$name", params: { name: schemaName } });
    } catch (_err) {
      toast.error(t("toast.deleteFailed", "Failed to delete record"));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }, [schemaName, recordId, navigate, t]);

  const handleCancel = useCallback(() => {
    if (!schemaName) return;
    if (isCreate) {
      navigate({ to: "/schemas/$name", params: { name: schemaName } });
    }
    // else: caller sets formMode to "view"
  }, [schemaName, isCreate, navigate]);

  const handleBack = useCallback(() => {
    if (!schemaName) return;
    navigate({ to: "/schemas/$name", params: { name: schemaName } });
  }, [schemaName, navigate]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  /** Fetch source record for cloning — strips system fields and resets state. */
  const fetchCloneSource = useCallback(
    async (
      cloneId: string,
      formView: { fields?: unknown } | undefined,
    ): Promise<Record<string, unknown> | null> => {
      if (!schemaName || !formView) return null;
      try {
        const result = await queryRecord(schemaName, cloneId, recordFieldsRef.current);
        if (result) {
          const cloned = { ...(result as Record<string, unknown>) };
          for (const field of CLONE_STRIP_FIELDS) {
            delete cloned[field];
          }
          // Reset state fields to initial value
          if (schema) {
            for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
              if (fieldDef.type === "state" && "machine" in fieldDef) {
                const machine = (bundle?.states ?? []).find(
                  (s) => s.name === fieldDef.machine && s.schema === schema.name,
                );
                if (machine && machine.states.length > 0) {
                  cloned[fieldName] = machine.initial ?? machine.states[0];
                }
              }
            }
          }
          return cloned;
        }
        console.warn(`Clone source record "${cloneId}" not found, starting with empty form.`);
        return null;
      } catch (err) {
        console.warn("Failed to load clone source:", err);
        toast.error(
          t(
            "toast.cloneSourceFailed",
            "Failed to load clone source. You can fill the form manually.",
          ),
        );
        return null;
      }
    },
    [schemaName, schema, bundle?.states, recordFieldsRef, t],
  );

  /** Fetch state transition history for a record. */
  const fetchStateTransitions = useCallback(
    async (id: string): Promise<StateTransitionInfo[]> => {
      if (!schemaName) return [];
      try {
        return await queryStateTransitions(schemaName, id);
      } catch {
        return [];
      }
    },
    [schemaName],
  );

  return {
    saving,
    deleting,
    deleteOpen,
    setDeleteOpen,
    handleSubmit,
    handleAction,
    executeDelete: executeDeleteAction,
    handleCancel,
    handleBack,
    handlePrint,
    fetchCloneSource,
    fetchStateTransitions,
  };
}
