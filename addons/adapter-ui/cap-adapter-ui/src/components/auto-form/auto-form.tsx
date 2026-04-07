/**
 * AutoForm — Schema-driven form with Odoo-style layout.
 *
 * Orchestrates form state, validation, and rendering of layout nodes
 * (groups, notebooks, fields, separators).
 *
 * Validation features:
 * - Client-side: Zod schema generated from EntityDefinition (required, min, max, format)
 * - Validates on blur (per-field) and on submit (all fields)
 * - Re-validates changed fields that previously had errors
 * - Server-side: parses GraphQL/API error responses and maps to field errors
 * - Displays form-level error banner for non-field-specific server errors
 * - Submit button disabled while validation errors exist
 * - i18n-aware error messages via Zod custom error map
 */

import { generateZodSchema } from "@linchkit/core/define";
import type {
  FieldDefinition,
  FieldVisibilityCondition,
  FormFieldNode,
  FormGroupNode,
  FormLayoutNode,
  FormNotebookNode,
  FormSeparatorNode,
  ViewAction,
} from "@linchkit/core/types";
import { Button } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { AlertCircle, Puzzle } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { evaluateVisibility } from "../../lib/field-visibility";
import { isMaskedValue } from "../../lib/masking";
import type { FieldOverlayRecord, OverlayFieldType } from "../../lib/overlay-types";
import { AiSuggestionBadge } from "../ai-suggestion-badge";
import { FormFieldRow } from "./form-field";
import { FormGroup } from "./form-group";
import { FormNotebook } from "./form-notebook";
import { TemplateSelector } from "./template-selector";
import type {
  AutoFormProps,
  ChildCommand,
  EnrichedSubmitData,
  SubmitResult,
  VirtualRecord,
} from "./types";

/** Schema-driven form component that renders entity fields with validation, layout groups, and overlay field support. */
export function AutoForm({
  schema,
  view,
  data,
  recordStatus,
  onSubmit,
  onCancel,
  onAction: _onAction,
  mode = "create",
  hideFooter = false,
  serverErrors: externalServerErrors,
  formError: externalFormError,
  aiSuggestions,
  onAiAccept: externalAiAccept,
  onAiReject,
  onValuesChange,
  registerSetField,
  templates,
  overlayFields,
  formId: customFormId,
}: AutoFormProps) {
  const { t } = useTranslation();
  const formId = customFormId ?? "auto-form";
  const zodSchema = useMemo(() => generateZodSchema(schema), [schema]);

  // Convert overlay fields to FieldDefinition map for rendering via widget registry
  const overlayFieldDefs = useMemo(() => buildOverlayFieldDefs(overlayFields), [overlayFields]);

  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const vf of view.fields) {
      if (vf.visible === false) continue;
      const fieldDef = schema.fields[vf.field];
      if (!fieldDef) continue;
      initial[vf.field] = data?.[vf.field] ?? fieldDef.default ?? getDefaultForType(fieldDef);
    }
    // Initialize overlay field values from _extensions
    if (overlayFields && overlayFields.length > 0) {
      const extensions = (data?._extensions ?? {}) as Record<string, unknown>;
      for (const overlay of overlayFields) {
        const key = overlayFieldKey(overlay.fieldName);
        initial[key] =
          extensions[overlay.fieldName] ??
          overlay.config.defaultValue ??
          getOverlayDefault(overlay.fieldType);
      }
    }
    return initial;
  });

  const initialDataRef = useRef<Record<string, unknown>>({ ...formData });
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<Record<string, number>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const isViewMode = mode === "view";

  // ── Record template state ──
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | undefined>(undefined);

  // Merge external server errors into local errors
  useEffect(() => {
    if (externalServerErrors && Object.keys(externalServerErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...externalServerErrors }));
    }
  }, [externalServerErrors]);

  useEffect(() => {
    if (externalFormError) {
      setFormError(externalFormError);
    }
  }, [externalFormError]);

  // ── Register setter for external field value updates (e.g. AI Accept All) ──
  useEffect(() => {
    if (registerSetField) {
      registerSetField((fieldName: string, value: unknown) => {
        handleChange(fieldName, value);
      });
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only re-register on mount
  }, [registerSetField, handleChange]);

  // ── State-driven action buttons ──

  const _resolvedActions = useMemo(() => {
    const allActions = view.actions ?? [];
    const headerActions = allActions.filter((a: ViewAction) => a.position === "form-header");
    const stateActions = view.stateActions;
    if (stateActions && recordStatus && recordStatus in stateActions) {
      const available = stateActions[recordStatus] ?? [];
      return headerActions.filter((a) => available.includes(a.action));
    }
    return headerActions;
  }, [view, recordStatus]);

  // ── i18n-aware Zod error message translation ──

  const translateZodMessage = useCallback(
    (code: string, fieldName: string, _details?: Record<string, unknown>): string => {
      const fieldDef = schema.fields[fieldName];
      const fieldLabel = fieldDef?.label ?? fieldName;

      switch (code) {
        case "invalid_type": {
          // When a required field receives undefined/null
          const details = _details as { received?: string } | undefined;
          if (
            fieldDef?.required &&
            (details?.received === "undefined" || details?.received === "null")
          ) {
            return t("form.required");
          }
          if (details?.received === "undefined" || details?.received === "null") {
            return t("form.required");
          }
          return t("form.invalid");
        }
        case "too_small":
          if (fieldDef?.type === "string" || fieldDef?.type === "text") {
            return t("form.validation.minLength", {
              defaultValue: "{{field}} must be at least {{min}} characters",
              field: fieldLabel,
              min: fieldDef.min ?? 1,
            });
          }
          return t("form.validation.min", {
            defaultValue: "{{field}} must be at least {{min}}",
            field: fieldLabel,
            min: fieldDef?.min ?? 0,
          });
        case "too_big":
          if (fieldDef?.type === "string" || fieldDef?.type === "text") {
            return t("form.validation.maxLength", {
              defaultValue: "{{field}} must be at most {{max}} characters",
              field: fieldLabel,
              max: fieldDef.max ?? 0,
            });
          }
          return t("form.validation.max", {
            defaultValue: "{{field}} must be at most {{max}}",
            field: fieldLabel,
            max: fieldDef?.max ?? 0,
          });
        case "invalid_string": {
          // Check if this is a pattern (regex) validation failure
          const stringDetails = _details as { validation?: string } | undefined;
          if (stringDetails?.validation === "regex") {
            return t("form.validation.pattern", {
              defaultValue: "{{field}} does not match the required format",
              field: fieldLabel,
            });
          }
          return t("form.validation.format", {
            defaultValue: "{{field}} format is invalid",
            field: fieldLabel,
          });
        }
        case "invalid_enum_value":
          return t("form.validation.invalidOption", {
            defaultValue: "Please select a valid option for {{field}}",
            field: fieldLabel,
          });
        default:
          return t("form.invalid");
      }
    },
    [schema, t],
  );

  // ── Validation ──

  const validateField = useCallback(
    (fieldName: string, value: unknown): string | undefined => {
      // Skip validation for masked values — they are read-only placeholders
      if (isMaskedValue(value)) return undefined;
      const fieldShape = zodSchema.shape[fieldName];
      if (!fieldShape) return undefined;
      const result = fieldShape.safeParse(value);
      if (!result.success) {
        const issue = result.error.issues[0];
        if (issue) {
          return translateZodMessage(
            issue.code,
            fieldName,
            issue as unknown as Record<string, unknown>,
          );
        }
        return t("form.invalid");
      }
      return undefined;
    },
    [zodSchema, t, translateZodMessage],
  );

  const validateAll = useCallback((): boolean => {
    // Strip masked values before validation — masked fields are read-only
    // and their server-side values are preserved; validating the masked
    // placeholder (e.g. "****e.com") against format rules (email) would
    // produce false negatives.
    const dataToValidate = { ...formData };
    for (const [key, value] of Object.entries(dataToValidate)) {
      if (isMaskedValue(value)) {
        delete dataToValidate[key];
      }
    }
    // Strip fields hidden by visibleWhen — they are not user-editable and
    // should not block form submission with validation errors.
    for (const vf of view.fields) {
      if (vf.visibleWhen && !evaluateVisibility(vf.visibleWhen, formData)) {
        delete dataToValidate[vf.field];
      }
    }
    const result = zodSchema.safeParse(dataToValidate);
    if (result.success) {
      setErrors({});
      return true;
    }
    const newErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const fieldName = issue.path[0];
      if (typeof fieldName === "string" && !newErrors[fieldName]) {
        newErrors[fieldName] = translateZodMessage(
          issue.code,
          fieldName,
          issue as unknown as Record<string, unknown>,
        );
      }
    }
    setErrors(newErrors);
    return false;
  }, [zodSchema, formData, translateZodMessage, view.fields]);

  // ── Handlers ──

  function handleChange(fieldName: string, value: unknown) {
    setFormData((prev) => {
      const next = { ...prev, [fieldName]: value };
      // Notify parent of value changes (deferred to avoid setState-during-render)
      if (onValuesChange) {
        queueMicrotask(() => onValuesChange(next));
      }
      return next;
    });

    // Clear form-level error on any change
    if (formError) setFormError(null);

    const isDirty = value !== initialDataRef.current[fieldName];
    setDirtyFields((prev) => {
      const next = new Set(prev);
      isDirty ? next.add(fieldName) : next.delete(fieldName);
      return next;
    });
    if (touchedFields.has(fieldName) && errors[fieldName]) {
      const err = validateField(fieldName, value);
      setErrors((prev) => {
        const next = { ...prev };
        if (err) {
          next[fieldName] = err;
        } else {
          delete next[fieldName];
        }
        return next;
      });
    }
  }

  function handleBlur(fieldName: string) {
    setTouchedFields((prev) => new Set(prev).add(fieldName));
    const err = validateField(fieldName, formData[fieldName]);
    setErrors((prev) => {
      const next = { ...prev };
      if (err) {
        next[fieldName] = err;
      } else {
        delete next[fieldName];
      }
      return next;
    });
  }

  function handleApplyTemplate(template: import("@linchkit/core/types").RecordTemplate) {
    // Merge template values into form data — existing defaults remain for fields not in template
    setFormData((prev) => ({ ...prev, ...template.values }));
    setAppliedTemplateId(template.id);
    // Clear any existing errors when applying a template
    setErrors({});
    setTouchedFields(new Set());
  }

  function handleClearTemplate() {
    // Reset to initial defaults
    const defaultData: Record<string, unknown> = {};
    for (const vf of view.fields) {
      if (vf.visible === false) continue;
      const fieldDef = schema.fields[vf.field];
      if (!fieldDef) continue;
      defaultData[vf.field] = data?.[vf.field] ?? fieldDef.default ?? getDefaultForType(fieldDef);
    }
    setFormData(defaultData);
    setAppliedTemplateId(undefined);
    setErrors({});
    setTouchedFields(new Set());
  }

  /** Scroll the first error field into view after validation failure.
   *  If the error element is inside a hidden notebook tab, activate that tab first. */
  function scrollToFirstError() {
    if (!formRef.current) return;
    // Find the first element with aria-invalid="true" or the first error message
    const firstInvalid = formRef.current.querySelector<HTMLElement>(
      '[aria-invalid="true"], [data-field] .text-destructive',
    );
    if (!firstInvalid) return;

    // If the element is inside a hidden tab panel, switch to that tab first
    const tabPanel = firstInvalid.closest<HTMLElement>('[role="tabpanel"]');
    if (tabPanel?.hidden) {
      const panelId = tabPanel.id;
      if (panelId) {
        // Find the tab trigger that controls this panel
        const trigger = formRef.current.querySelector<HTMLElement>(
          `[role="tab"][aria-controls="${panelId}"]`,
        );
        if (trigger) {
          trigger.click();
        }
      }
    }

    // Use requestAnimationFrame to let the DOM update after potential tab switch
    requestAnimationFrame(() => {
      firstInvalid.scrollIntoView({ behavior: "smooth", block: "center" });
      // Focus the input if it's focusable
      if ("focus" in firstInvalid && typeof firstInvalid.focus === "function") {
        firstInvalid.focus({ preventScroll: true });
      }
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Mark all fields as touched on submit attempt
    const allFields = new Set<string>(
      view.fields.filter((f) => f.visible !== false).map((f) => f.field),
    );
    setTouchedFields(allFields);

    // Clear previous form-level error
    setFormError(null);

    if (!validateAll()) {
      // Scroll to first field with an error
      scrollToFirstError();
      return;
    }

    // Exclude hidden fields (visibleWhen condition not met) and masked
    // fields (read-only server placeholders) from submission
    const submitData = { ...formData };
    for (const [key, value] of Object.entries(submitData)) {
      if (isMaskedValue(value)) {
        delete submitData[key];
      }
    }
    for (const vf of view.fields) {
      const condition = vf.visibleWhen;
      if (condition && !evaluateVisibility(condition, formData)) {
        delete submitData[vf.field];
      }
    }
    // Also check layout nodes for visibleWhen on FormFieldNodes
    function collectHiddenLayoutFields(nodes: FormLayoutNode[]) {
      for (const node of nodes) {
        if (node.type === "field" && node.visibleWhen) {
          if (!evaluateVisibility(node.visibleWhen, formData)) {
            delete submitData[node.field];
          }
        } else if (node.type === "group" || node.type === "page") {
          collectHiddenLayoutFields(node.children);
        } else if (node.type === "notebook") {
          collectHiddenLayoutFields(node.children);
        }
      }
    }
    if (view.layout?.nodes) {
      collectHiddenLayoutFields(view.layout.nodes);
    }

    // Move overlay field values into _extensions and remove from top-level
    if (overlayFields && overlayFields.length > 0) {
      const extensions: Record<string, unknown> = {};
      for (const overlay of overlayFields) {
        const key = overlayFieldKey(overlay.fieldName);
        if (key in submitData) {
          extensions[overlay.fieldName] = submitData[key];
          delete submitData[key];
        }
      }
      if (Object.keys(extensions).length > 0) {
        submitData._extensions = extensions;
      }
    }

    // Collect virtual ref records and has_many child commands
    const virtualRefs: Record<string, VirtualRecord> = {};
    const childCommands: Record<string, ChildCommand[]> = {};

    for (const [key, val] of Object.entries(submitData)) {
      const fieldDef = schema.fields[key];
      if (!fieldDef) continue;

      // Detect virtual ref records (ref fields holding an object with _virtual flag)
      if (
        fieldDef.type === "ref" &&
        typeof val === "object" &&
        val !== null &&
        "_virtual" in val &&
        (val as Record<string, unknown>)._virtual === true
      ) {
        const record = val as Record<string, unknown>;
        virtualRefs[key] = {
          _virtual: true,
          _tempId: String(record.id ?? record._tempId ?? ""),
          ...record,
        };
      }

      // Collect has_many child record commands
      if (fieldDef.type === "has_many" && Array.isArray(val)) {
        const commands: ChildCommand[] = [];
        const existingRecords = Array.isArray(data?.[key])
          ? (data[key] as Array<Record<string, unknown>>)
          : [];
        const existingIds = new Set(existingRecords.map((r) => String(r.id)));
        const currentIds = new Set<string>();

        for (const child of val as Array<Record<string, unknown>>) {
          const childId = String(child.id ?? "");
          const isVirtual = childId.startsWith("_virtual_");

          if (isVirtual) {
            // New child record
            const values = { ...child };
            delete values.id;
            delete values._virtual;
            commands.push({ type: "create", tempId: childId, values });
          } else {
            // Existing child — check if modified
            currentIds.add(childId);
            const original = existingRecords.find((r) => String(r.id) === childId);
            if (original) {
              const changes: Record<string, unknown> = {};
              let hasChanges = false;
              for (const [field, fieldVal] of Object.entries(child)) {
                if (field === "id" || field === "_virtual") continue;
                if (fieldVal !== original[field]) {
                  changes[field] = fieldVal;
                  hasChanges = true;
                }
              }
              if (hasChanges) {
                commands.push({ type: "update", id: childId, values: changes });
              }
            }
          }
        }

        // Detect deleted children (present in original data but missing from current)
        for (const existingId of existingIds) {
          if (!currentIds.has(existingId)) {
            commands.push({ type: "delete", id: existingId });
          }
        }

        if (commands.length > 0) {
          childCommands[key] = commands;
        }
      }
    }

    const enriched: EnrichedSubmitData = {
      values: submitData,
      virtualRefs,
      childCommands,
    };

    setSubmitting(true);
    try {
      const result = await onSubmit?.(submitData, enriched);

      // Handle server-side errors returned by onSubmit
      if (result) {
        const submitResult = result as SubmitResult;
        if (submitResult.fieldErrors) {
          setErrors((prev) => ({ ...prev, ...submitResult.fieldErrors }));
        }
        if (submitResult.formError) {
          setFormError(submitResult.formError);
        }
      }
    } catch (err) {
      // Parse server error responses
      const parsed = parseServerError(err);
      if (parsed.fieldErrors) {
        setErrors((prev) => ({ ...prev, ...parsed.fieldErrors }));
      }
      if (parsed.formError) {
        setFormError(parsed.formError);
      }
    } finally {
      setSubmitting(false);
    }
  }

  function isFieldReadonly(
    fieldName: string,
    fieldDef: FieldDefinition,
    nodeReadonly?: boolean,
  ): boolean {
    if (isViewMode) return true;
    if (nodeReadonly) return true;
    const vf = view.fields.find((f) => f.field === fieldName);
    if (vf?.readonly) return true;
    if (fieldDef.type === "state") return true;
    if (mode === "edit" && fieldDef.immutable) return true;
    return false;
  }

  // ── Field visibility ──

  /** Resolve visibleWhen condition from FormFieldNode or ViewFieldConfig */
  function getVisibleWhen(node: FormFieldNode): FieldVisibilityCondition | undefined {
    if (node.visibleWhen) return node.visibleWhen;
    const vf = view.fields.find((f) => f.field === node.field);
    return vf?.visibleWhen;
  }

  /** Check if a field is currently visible based on its visibleWhen condition */
  function isFieldVisible(node: FormFieldNode): boolean {
    return evaluateVisibility(getVisibleWhen(node), formData);
  }

  // ── Layout rendering ──

  function renderField(node: FormFieldNode) {
    const fieldDef = schema.fields[node.field];
    const vf = view.fields.find((f) => f.field === node.field);
    if (!fieldDef) return null;

    const visible = isFieldVisible(node);

    const required = !!fieldDef.required && !isViewMode;
    const readonly = isFieldReadonly(node.field, fieldDef, node.readonly);
    const suggestion = aiSuggestions?.[node.field];

    const hasCondition = !!(
      node.visibleWhen ?? view.fields.find((f) => f.field === node.field)?.visibleWhen
    );

    // Fields with visibleWhen: keep in DOM for CSS transition; fields without: skip entirely when invisible
    if (!visible && !hasCondition) return null;

    const fieldRow = (
      <FormFieldRow
        key={node.field}
        node={node}
        fieldDef={fieldDef}
        viewField={vf ?? { field: node.field }}
        value={formData[node.field]}
        isViewMode={isViewMode}
        required={required}
        readonly={readonly}
        error={errors[node.field]}
        isDirty={dirtyFields.has(node.field)}
        onChange={(val) => handleChange(node.field, val)}
        onBlur={() => handleBlur(node.field)}
      />
    );

    const suggestionBadge =
      suggestion && !isViewMode ? (
        <div className="col-span-full px-1 -mt-1 mb-1">
          <AiSuggestionBadge
            suggestion={suggestion}
            onAccept={() => externalAiAccept?.(node.field)}
            onReject={() => onAiReject?.(node.field)}
          />
        </div>
      ) : null;

    if (!hasCondition) {
      return (
        <>
          {fieldRow}
          {suggestionBadge}
        </>
      );
    }

    return (
      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-in-out",
          visible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0 pointer-events-none",
        )}
      >
        <div className="overflow-hidden">
          {fieldRow}
          {suggestionBadge}
        </div>
      </div>
    );
  }

  function renderGroup(node: FormGroupNode, depth = 0) {
    return <FormGroup node={node} depth={depth} renderNode={renderNode} />;
  }

  function renderNotebook(node: FormNotebookNode) {
    const notebookId = node.children.map((p) => p.title).join("-");
    const currentTab = activeTab[notebookId] ?? 0;

    return (
      <FormNotebook
        node={node}
        activeTab={currentTab}
        onTabChange={(i) => setActiveTab((prev) => ({ ...prev, [notebookId]: i }))}
        renderNode={renderNode}
      />
    );
  }

  function renderSeparator(node: FormSeparatorNode) {
    return (
      <div className="py-3">
        {node.label ? (
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {node.label}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        ) : (
          <div className="h-px bg-border" />
        )}
      </div>
    );
  }

  function renderNode(node: FormLayoutNode, depth = 0): React.ReactNode {
    switch (node.type) {
      case "field":
        return renderField(node);
      case "group":
        return renderGroup(node, depth);
      case "notebook":
        return renderNotebook(node);
      case "page":
        return null;
      case "separator":
        return renderSeparator(node);
      default:
        return null;
    }
  }

  // Resolve layout: nodes -> legacy sections -> auto-generate
  const layoutNodes = useMemo((): FormLayoutNode[] => {
    if (view.layout?.nodes && view.layout.nodes.length > 0) {
      return view.layout.nodes;
    }
    if (view.layout?.sections && view.layout.sections.length > 0) {
      return view.layout.sections.map(
        (section): FormGroupNode => ({
          type: "group",
          title: section.title,
          columns: 1,
          children: section.fields.map((f): FormFieldNode => ({ type: "field", field: f })),
        }),
      );
    }
    const visibleFields = view.fields.filter((f) => f.visible !== false).map((f) => f.field);
    return [
      {
        type: "group",
        children: visibleFields.map((f): FormFieldNode => ({ type: "field", field: f })),
      },
    ];
  }, [view]);

  const hasDirtyFields = dirtyFields.size > 0;
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <form id={formId} ref={formRef} onSubmit={handleSubmit} noValidate>
      {/* Template selector — create mode only */}
      {mode === "create" && templates && templates.length > 0 && (
        <TemplateSelector
          templates={templates}
          onSelect={handleApplyTemplate}
          onClear={handleClearTemplate}
          selectedId={appliedTemplateId}
        />
      )}

      {/* Form-level error banner */}
      {formError && !isViewMode && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{formError}</span>
        </div>
      )}

      {/* Layout nodes */}
      {layoutNodes.map((node, i) => (
        <Fragment key={getNodeKey(node, i)}>{renderNode(node, 0)}</Fragment>
      ))}

      {/* Overlay (custom) fields section */}
      {overlayFields && overlayFields.length > 0 && (
        <div className="mt-4" data-overlay-fields>
          <div className="py-3 border-b border-border/50">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Puzzle className="size-3.5 opacity-60" />
              {t("form.overlayFields", "Custom Fields")}
            </h3>
          </div>
          <div
            className="grid gap-y-2 items-center mt-2 max-md:!grid-cols-1"
            style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}
          >
            {overlayFields.map((overlay) => {
              const key = overlayFieldKey(overlay.fieldName);
              const fieldDef = overlayFieldDefs[overlay.fieldName];
              if (!fieldDef) return null;
              const node: FormFieldNode = { type: "field", field: key };
              const vf = { field: key };
              const readonly = isViewMode;
              const required = !!overlay.config.required && !isViewMode;
              return (
                <FormFieldRow
                  key={key}
                  node={node}
                  fieldDef={fieldDef}
                  viewField={vf}
                  value={formData[key]}
                  isViewMode={isViewMode}
                  required={required}
                  readonly={readonly}
                  error={errors[key]}
                  isDirty={dirtyFields.has(key)}
                  onChange={(val) => handleChange(key, val)}
                  onBlur={() => handleBlur(key)}
                  overlayIndicator
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      {!isViewMode && !hideFooter && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-muted-foreground">
            {hasErrors ? (
              <span className="inline-flex items-center gap-1.5 text-destructive">
                <AlertCircle className="size-3.5" />
                {t("form.validation.hasErrors", "Please fix the errors below before submitting")}
              </span>
            ) : hasDirtyFields ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-primary" />
                {t("form.fieldModified")}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
            )}
            <Button type="submit" disabled={hasErrors || submitting}>
              {mode === "create" ? t("common.create") : t("common.save")}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── Helpers ───────────────────────────────

function getDefaultForType(fieldDef: FieldDefinition): unknown {
  switch (fieldDef.type) {
    case "boolean":
      return false;
    case "number":
    case "enum":
    case "state":
      return null;
    default:
      return "";
  }
}

/** Prefix for overlay field keys in formData to avoid collision with schema fields. */
const OVERLAY_PREFIX = "_ovl_";

function overlayFieldKey(fieldName: string): string {
  return `${OVERLAY_PREFIX}${fieldName}`;
}

/** Map overlay field type to core FieldType for widget resolution. */
function overlayTypeToFieldType(overlayType: OverlayFieldType): FieldDefinition["type"] {
  switch (overlayType) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "enum":
      return "enum";
    case "json":
      return "json";
    default:
      return "string";
  }
}

/** Get default value for an overlay field type. */
function getOverlayDefault(overlayType: OverlayFieldType): unknown {
  switch (overlayType) {
    case "boolean":
      return false;
    case "number":
      return null;
    case "json":
      return null;
    default:
      return "";
  }
}

/**
 * Convert overlay field records to a map of synthetic FieldDefinition objects
 * that the widget registry can use for rendering.
 */
function buildOverlayFieldDefs(
  overlayFields: FieldOverlayRecord[] | undefined,
): Record<string, FieldDefinition> {
  if (!overlayFields) return {};
  const defs: Record<string, FieldDefinition> = {};
  for (const overlay of overlayFields) {
    const base: FieldDefinition = {
      type: overlayTypeToFieldType(overlay.fieldType),
      label: resolveOverlayLabel(overlay),
      required: overlay.config.required,
    } as FieldDefinition;

    // Add enum options if applicable
    if (overlay.fieldType === "enum" && overlay.config.enumValues) {
      (base as { options: Array<{ value: string; label: string }> }).options =
        overlay.config.enumValues.map((v) => ({ value: v, label: v }));
    }

    // Add numeric constraints
    if (overlay.fieldType === "number") {
      if (overlay.config.min !== undefined) base.min = overlay.config.min;
      if (overlay.config.max !== undefined) base.max = overlay.config.max;
    }

    // Add string max length
    if (overlay.fieldType === "string" && overlay.config.maxLength !== undefined) {
      base.max = overlay.config.maxLength;
    }

    defs[overlay.fieldName] = base;
  }
  return defs;
}

/**
 * Resolve the best label for an overlay field.
 * Tries current i18next language, then 'en', then field name.
 */
function resolveOverlayLabel(overlay: FieldOverlayRecord): string {
  if (!overlay.config.label) return overlay.fieldName;
  // Try browser language first, then English fallback
  const lang = typeof navigator !== "undefined" ? navigator.language.replace("-", "-") : "en";
  return (
    overlay.config.label[lang] ??
    overlay.config.label.en ??
    Object.values(overlay.config.label)[0] ??
    overlay.fieldName
  );
}

function _mapVariant(v?: string): "default" | "destructive" | "outline" | "ghost" | "secondary" {
  if (
    v === "default" ||
    v === "destructive" ||
    v === "outline" ||
    v === "ghost" ||
    v === "secondary"
  )
    return v;
  return "outline";
}

function getNodeKey(node: FormLayoutNode, index: number): string {
  switch (node.type) {
    case "field":
      return `field-${node.field}`;
    case "group":
      return `group-${node.title ?? index}`;
    case "notebook":
      return `notebook-${index}`;
    case "page":
      return `page-${node.title}`;
    case "separator":
      return `sep-${node.label ?? index}`;
    default:
      return `node-${index}`;
  }
}

/**
 * Parse server error responses into field-level and form-level errors.
 *
 * Handles:
 * - GraphQL validation errors with field paths
 * - REST API validation errors with field details
 * - Generic Error instances
 */
function parseServerError(err: unknown): {
  fieldErrors?: Record<string, string>;
  formError?: string;
} {
  if (!err) return {};

  // Handle Error instances with structured data
  if (err instanceof Error) {
    const message = err.message;

    // Try to parse GraphQL-style error with field details
    // e.g. "Validation failed: title is required, amount must be positive"
    const fieldErrors = parseValidationMessage(message);
    if (fieldErrors && Object.keys(fieldErrors).length > 0) {
      return { fieldErrors };
    }

    return { formError: message };
  }

  // Handle plain objects (e.g. from response.json())
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;

    // REST-style: { error: { code: "validation", details: { field: "message" } } }
    if (obj.error && typeof obj.error === "object") {
      const error = obj.error as Record<string, unknown>;
      if (error.details && typeof error.details === "object") {
        return { fieldErrors: error.details as Record<string, string> };
      }
      if (typeof error.message === "string") {
        return { formError: error.message };
      }
    }

    // GraphQL-style: { errors: [{ message, extensions: { fieldErrors } }] }
    if (Array.isArray(obj.errors)) {
      const fieldErrors: Record<string, string> = {};
      let formMessage: string | undefined;

      for (const gqlError of obj.errors) {
        if (typeof gqlError === "object" && gqlError !== null) {
          const ext = (gqlError as Record<string, unknown>).extensions as
            | Record<string, unknown>
            | undefined;
          if (ext?.fieldErrors && typeof ext.fieldErrors === "object") {
            Object.assign(fieldErrors, ext.fieldErrors);
          } else {
            formMessage = String((gqlError as Record<string, unknown>).message ?? "");
          }
        }
      }

      if (Object.keys(fieldErrors).length > 0) {
        return { fieldErrors, formError: formMessage };
      }
      if (formMessage) {
        return { formError: formMessage };
      }
    }
  }

  return { formError: String(err) };
}

/**
 * Try to extract field-level errors from a validation error message string.
 * Matches patterns like "fieldName: error message" or "fieldName is required".
 */
function parseValidationMessage(message: string): Record<string, string> | null {
  // Pattern: "Validation failed: field1 error, field2 error"
  const validationPrefix = /^(?:Validation (?:failed|error)):?\s*/i;
  const body = message.replace(validationPrefix, "");

  // Try "field: message" pattern (common in REST APIs)
  const colonPattern = /(\w+):\s*([^,]+)/g;
  const result: Record<string, string> = {};
  let match: RegExpExecArray | null;

  match = colonPattern.exec(body);
  while (match !== null) {
    const field = match[1];
    const msg = match[2];
    if (field && msg) {
      result[field] = msg.trim();
    }
    match = colonPattern.exec(body);
  }

  return Object.keys(result).length > 0 ? result : null;
}
