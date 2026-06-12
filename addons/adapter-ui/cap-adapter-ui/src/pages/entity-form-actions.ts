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
import { useCallback, useMemo, useState } from "react";
import type { EnrichedSubmitData } from "../components/auto-form/types";
import type { StateTransitionInfo } from "../components/status-bar";
import type { ResolvedEntityBundle } from "../hooks/use-entity-bundle";
import { pushNotification } from "../hooks/use-notifications";
import { resolveActionErrorMessage } from "../lib/action-errors";
import { executeAction } from "../lib/api";
import {
  createRecord,
  deleteRecord,
  queryRecord,
  queryStateTransitions,
  updateRecord,
} from "../lib/entity-api";
import { CLONE_STRIP_FIELDS, getMutationReturnFields } from "../lib/entity-form-utils";

/** Transition descriptor from useTransitionPermissions */
export interface TransitionInfo {
  action: string;
  to: string;
}

// ── Header-action dispatch (dependency-injected for tests) ──────────────────

/** Minimal API surface consumed by executeHeaderAction — injectable in tests. */
export interface HeaderActionApi {
  executeAction: (
    actionName: string,
    input: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: { message?: string }; data?: unknown }>;
  queryRecord: (
    schema: string,
    id: string,
    fields: string[],
  ) => Promise<Record<string, unknown> | null>;
}

/** Structured outcome of a header-action click; the hook maps it to toasts/refreshes. */
export type HeaderActionOutcome =
  | { kind: "transition_success"; updated: Record<string, unknown> | null }
  | { kind: "action_success" }
  | { kind: "failed"; message?: string };

/**
 * Execute a header action click.
 *
 * A header action bound to a state transition (`transition.action === actionName`)
 * MUST run through the Action itself: the server-side action performs the
 * declarative `stateTransition`, stamps `setFields`, and fires rules/flows
 * (e.g. `submit_purchase_request` stamps `submitted_at` and triggers the
 * approval Flow). Routing it through the generic `transitionRecord` mutation
 * bypasses all of that — it degrades to a bare status update. The generic
 * transition mutation remains valid ONLY for raw transitions invoked without
 * a bound action (transition pills / kanban drags dispatch the same way via
 * lib/transition-dispatch.ts); no such path exists in this dispatcher
 * because it is keyed by action name.
 *
 * After a successful transition-bound action the fresh record is re-queried
 * so the form can update local state in place; `updated: null` means the
 * re-query failed or returned nothing and the caller should fall back to a
 * full record refetch.
 */
export async function executeHeaderAction(opts: {
  actionName: string;
  entityName: string;
  recordId: string;
  recordFields: string[];
  availableTransitions: TransitionInfo[];
  api: HeaderActionApi;
}): Promise<HeaderActionOutcome> {
  const { actionName, entityName, recordId, recordFields, availableTransitions, api } = opts;
  const transition = availableTransitions.find((tr) => tr.action === actionName);

  const result = await api.executeAction(actionName, { id: recordId });
  // The optional chain is a defensive null guard: a (mis)implemented api
  // could resolve to null/undefined despite the type — treat it as a plain
  // failure so the caller falls back to its generic message, not a throw.
  if (!result?.success) {
    // Surface the server's failure reason (e.g. a rule-block message) so the
    // caller can show it instead of a generic "Action failed" toast.
    const message = resolveActionErrorMessage(result);
    return message ? { kind: "failed", message } : { kind: "failed" };
  }

  if (!transition) return { kind: "action_success" };

  // Transition-bound action succeeded — re-query the record (status, setFields
  // stamps, derived fields) so the form refresh keeps working.
  let updated: Record<string, unknown> | null = null;
  try {
    updated = await api.queryRecord(entityName, recordId, recordFields);
  } catch {
    updated = null;
  }
  return { kind: "transition_success", updated };
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
    refetchTransitions,
    t,
  } = opts;

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Build set of auto-generated FK column names from relations (e.g., "department_id")
  // These may not be in schema.fields but are valid mutation input fields.
  const relationFkColumns = useMemo(() => {
    const fkSet = new Set<string>();
    if (bundle?.relations && entityName) {
      for (const rel of bundle.relations) {
        if (
          rel.from === entityName &&
          (rel.cardinality === "many_to_one" || rel.cardinality === "one_to_one")
        ) {
          fkSet.add(`${rel.fromName}_id`);
        }
      }
    }
    return fkSet;
  }, [bundle?.relations, entityName]);

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
            if (!isRelationFk && fieldDef?.type !== "string") continue;
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
      // biome-ignore lint/correctness/useExhaustiveDependencies: prepareMutationInput depends on schema and relationFkColumns
      prepareMutationInput,
      relationFkColumns,
    ],
  );

  const handleAction = useCallback(
    async (actionName: string): Promise<Record<string, unknown> | undefined> => {
      setSaving(true);
      try {
        if (!recordId) return;

        // Transition-bound header actions run through the bound Action (NOT
        // the generic transition mutation) — see executeHeaderAction docs.
        const outcome = await executeHeaderAction({
          actionName,
          entityName: entityName ?? "",
          recordId,
          recordFields,
          availableTransitions,
          api: { executeAction, queryRecord },
        });

        if (outcome.kind === "transition_success") {
          toast.success(t("toast.transitionSuccess", "Status changed successfully"));
          if (outcome.updated) {
            // Hand the fresh record to the caller so it can update local
            // state and refetch transition permissions.
            return outcome.updated;
          }
          // Re-query failed or returned nothing — fall back to a full refetch.
          // Returning undefined means the caller skips its own refetch of the
          // transition permissions, so refresh them here too: the transition
          // DID succeed and the available actions have changed.
          await fetchRecord();
          await refetchTransitions();
          return undefined;
        }

        if (outcome.kind === "action_success") {
          toast.success(t("toast.actionSuccess", "Action executed successfully"));
          pushNotification({
            type: "action_success",
            message: t("notifications.actionSucceeded", { action: actionName }),
            schema: entityName,
            recordId,
          });
          await fetchRecord();
        } else {
          // Prefer the server's failure reason (e.g. "Amounts over 10000
          // require manager approval" from a rule block) over the generic text.
          toast.error(outcome.message ?? t("toast.actionFailed", "Action failed"));
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
    [recordId, entityName, availableTransitions, recordFields, fetchRecord, refetchTransitions, t],
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
