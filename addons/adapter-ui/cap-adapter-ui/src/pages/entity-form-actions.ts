/**
 * Schema form page — action execution logic extracted as a custom hook.
 *
 * Handles: submit (create/update), cancel, business action execution,
 * state transitions, delete, and clone source fetching.
 */

import type { EntityDefinition } from "@linchkit/core/types";
import { toast } from "@linchkit/ui-kit/components";
import type { NavigateOptions } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useCallback, useState } from "react";
import type { EnrichedSubmitData } from "../components/auto-form/types";
import type { StateTransitionInfo } from "../components/status-bar";
import type { ResolvedEntityBundle } from "../hooks/use-entity-bundle";
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
import { CLONE_STRIP_FIELDS, getMutationReturnFields } from "../lib/entity-form-utils";

/** Transition descriptor from useTransitionPermissions */
export interface TransitionInfo {
  action: string;
  to: string;
}

export interface UseFormActionsOptions {
  entityName: string | undefined;
  recordId: string | undefined;
  isCreate: boolean;
  schema: EntityDefinition | undefined;
  bundle: ResolvedEntityBundle | undefined;
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
    entityName,
    recordId,
    isCreate,
    schema,
    bundle,
    recordFields,
    recordFieldsRef,
    availableTransitions,
    navigate,
    fetchRecord,
    t,
  } = opts;

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Build set of auto-generated FK column names from relations (e.g., "department_id")
  // These may not be in schema.fields but are valid mutation input fields.
  const relationFkColumns = new Set<string>();
  if (bundle?.relations && entityName) {
    for (const rel of bundle.relations) {
      if (
        rel.from === entityName &&
        (rel.cardinality === "many_to_one" || rel.cardinality === "one_to_one")
      ) {
        relationFkColumns.add(`${rel.fromName}_id`);
      }
    }
  }

  /** Prepare mutation input by stripping non-input fields. FK fields (string type) are passed through directly. */
  function prepareMutationInput(data: Record<string, unknown>): Record<string, unknown> {
    if (!schema) return data;
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      // Allow relation FK columns that are auto-generated from defineRelation()
      if (relationFkColumns.has(key)) {
        if (typeof value === "object" && value !== null && "id" in value) {
          input[key] = (value as { id: string }).id;
        } else {
          input[key] = value;
        }
        continue;
      }
      const fieldDef = schema.fields[key];
      if (!fieldDef) continue;
      // Skip derived fields — they are computed, not user input
      if (fieldDef.derived) continue;
      // Extract ID from expanded object for FK string fields (e.g. department_id)
      if (
        fieldDef.type === "string" &&
        typeof value === "object" &&
        value !== null &&
        "id" in value
      ) {
        const refValue = (value as { id: string }).id;
        if (refValue != null && refValue !== "") {
          input[key] = refValue;
        }
        continue;
      }
      input[key] = value;
    }
    return input;
  }

  const handleSubmit = useCallback(
    async (data: Record<string, unknown>, enriched?: EnrichedSubmitData): Promise<undefined> => {
      if (!entityName) return;
      setSaving(true);
      try {
        // Step 1: Create virtual ref records first (quick-created related records)
        const virtualRefIdMap = new Map<string, string>(); // tempId -> real ID
        if (enriched?.virtualRefs) {
          for (const [fieldName, virtualRecord] of Object.entries(enriched.virtualRefs)) {
            // Allow both explicit FK fields and auto-generated FK columns from relations
            const fieldDef = schema?.fields[fieldName];
            const isRelationFk = relationFkColumns.has(fieldName);
            if (!isRelationFk && (!fieldDef || fieldDef.type !== "string")) continue;
            // Resolve target entity from relations
            const relation = bundle?.relations?.find(
              (l) => l.from === entityName && l.fromName === fieldName.replace(/_id$/, ""),
            );
            if (!relation) continue;

            // Build input from virtual record, stripping internal fields
            const refInput: Record<string, unknown> = {};
            for (const [key, val] of Object.entries(virtualRecord)) {
              if (key === "_virtual" || key === "_tempId" || key === "id") continue;
              refInput[key] = val;
            }

            const created = await createRecord<{ id: string }>(relation.to, refInput, ["id"]);
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
        const mutationReturnFields = getMutationReturnFields(
          recordFields,
          schema,
          bundle?.relations,
        );
        let parentRecordId = recordId;
        if (isCreate) {
          const created = await createRecord<{ id: string }>(entityName, mutationInput, [
            "id",
            ...mutationReturnFields,
          ]);
          parentRecordId = created.id;
        } else if (parentRecordId) {
          await updateRecord(entityName, parentRecordId, mutationInput, mutationReturnFields);
        }

        // Step 4: Process child commands (one_to_many inline records via relations)
        if (enriched?.childCommands && parentRecordId) {
          for (const [fieldName, commands] of Object.entries(enriched.childCommands)) {
            // Resolve target entity from relation by semantic name
            const relation = bundle?.relations?.find(
              (l) =>
                (l.cardinality === "one_to_many" &&
                  l.from === entityName &&
                  l.fromName === fieldName) ||
                (l.cardinality === "many_to_one" && l.to === entityName && l.toName === fieldName),
            );
            if (!relation) continue;
            const targetSchema = relation.from === entityName ? relation.to : relation.from;
            const fkColumn = `${entityName}_id`;

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
          navigate({ to: "/entities/$name", params: { name: entityName } });
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
    [
      entityName,
      recordId,
      isCreate,
      schema,
      bundle?.relations,
      recordFields,
      navigate,
      fetchRecord,
      t,
      // biome-ignore lint/correctness/useExhaustiveDependencies: prepareMutationInput only depends on schema which is stable
      prepareMutationInput,
    ],
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
            entityName ?? "",
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
            schema: entityName,
            recordId,
          });
          await fetchRecord();
        } else {
          toast.error(t("toast.actionFailed", "Action failed"));
          pushNotification({
            type: "action_failure",
            message: t("notifications.actionFailed", { action: actionName }),
            schema: entityName,
            recordId,
          });
        }
        return undefined;
      } catch (_err) {
        toast.error(t("toast.actionFailed", "Action failed"));
        pushNotification({
          type: "action_failure",
          message: t("notifications.actionFailed", { action: actionName }),
          schema: entityName,
        });
        return undefined;
      } finally {
        setSaving(false);
      }
    },
    [recordId, entityName, availableTransitions, recordFields, fetchRecord, t],
  );

  const executeDeleteAction = useCallback(async () => {
    if (!entityName || !recordId) return;
    setDeleting(true);
    try {
      await deleteRecord(entityName, recordId);
      toast.success(t("toast.recordDeleted", "Record deleted successfully"));
      navigate({ to: "/entities/$name", params: { name: entityName } });
    } catch (_err) {
      toast.error(t("toast.deleteFailed", "Failed to delete record"));
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }, [entityName, recordId, navigate, t]);

  const handleCancel = useCallback(() => {
    if (!entityName) return;
    if (isCreate) {
      navigate({ to: "/entities/$name", params: { name: entityName } });
    }
    // else: caller sets formMode to "view"
  }, [entityName, isCreate, navigate]);

  const handleBack = useCallback(() => {
    if (!entityName) return;
    navigate({ to: "/entities/$name", params: { name: entityName } });
  }, [entityName, navigate]);

  const handlePrint = useCallback(() => {
    window.print();
  }, []);

  /** Fetch source record for cloning — strips system fields and resets state. */
  const fetchCloneSource = useCallback(
    async (
      cloneId: string,
      formView: { fields?: unknown } | undefined,
    ): Promise<Record<string, unknown> | null> => {
      if (!entityName || !formView) return null;
      try {
        const result = await queryRecord(entityName, cloneId, recordFieldsRef.current);
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
                  (s) => s.name === fieldDef.machine && s.entity === schema.name,
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
    [entityName, schema, bundle?.states, recordFieldsRef, t],
  );

  /** Fetch state transition history for a record. */
  const fetchStateTransitions = useCallback(
    async (id: string): Promise<StateTransitionInfo[]> => {
      if (!entityName) return [];
      try {
        return await queryStateTransitions(entityName, id);
      } catch {
        return [];
      }
    },
    [entityName],
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
