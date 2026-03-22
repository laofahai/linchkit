/**
 * AutoForm — Schema-driven form with Odoo-style layout.
 *
 * Orchestrates form state, validation, and rendering of layout nodes
 * (groups, notebooks, fields, separators).
 */

import type {
  FieldDefinition,
  FormFieldNode,
  FormGroupNode,
  FormLayoutNode,
  FormNotebookNode,
  FormSeparatorNode,
  ViewAction,
} from "@linchkit/core";
import { generateZodSchema } from "@linchkit/core";
import { Button } from "@linchkit/ui-kit/components";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormFieldRow } from "./form-field";
import { FormGroup } from "./form-group";
import { FormNotebook } from "./form-notebook";
import type { AutoFormProps, ViewDefinitionWithStateActions } from "./types";

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
}: AutoFormProps) {
  const { t } = useTranslation();
  const zodSchema = useMemo(() => generateZodSchema(schema), [schema]);

  const [formData, setFormData] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const vf of view.fields) {
      if (vf.visible === false) continue;
      const fieldDef = schema.fields[vf.field];
      if (!fieldDef) continue;
      initial[vf.field] = data?.[vf.field] ?? fieldDef.default ?? getDefaultForType(fieldDef);
    }
    return initial;
  });

  const initialDataRef = useRef<Record<string, unknown>>({ ...formData });
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<Record<string, number>>({});

  const isViewMode = mode === "view";

  // ── State-driven action buttons ──

  const _resolvedActions = useMemo(() => {
    const allActions = view.actions ?? [];
    const headerActions = allActions.filter((a: ViewAction) => a.position === "form-header");
    const stateActions = (view as ViewDefinitionWithStateActions).stateActions;
    if (stateActions && recordStatus && recordStatus in stateActions) {
      const available = stateActions[recordStatus] ?? [];
      return headerActions.filter((a) => available.includes(a.action));
    }
    return headerActions;
  }, [view, recordStatus]);

  // ── Validation ──

  const validateField = useCallback(
    (fieldName: string, value: unknown): string | undefined => {
      const fieldShape = zodSchema.shape[fieldName];
      if (!fieldShape) return undefined;
      const result = fieldShape.safeParse(value);
      if (!result.success) {
        return result.error.issues[0]?.message ?? t("form.invalid");
      }
      return undefined;
    },
    [zodSchema, t],
  );

  const validateAll = useCallback((): boolean => {
    const result = zodSchema.safeParse(formData);
    if (result.success) {
      setErrors({});
      return true;
    }
    const newErrors: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const fieldName = issue.path[0];
      if (typeof fieldName === "string" && !newErrors[fieldName]) {
        newErrors[fieldName] = issue.message;
      }
    }
    setErrors(newErrors);
    return false;
  }, [zodSchema, formData]);

  // ── Handlers ──

  function handleChange(fieldName: string, value: unknown) {
    setFormData((prev) => ({ ...prev, [fieldName]: value }));
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validateAll()) {
      onSubmit?.(formData);
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

  // ── Layout rendering ──

  function renderField(node: FormFieldNode) {
    const fieldDef = schema.fields[node.field];
    const vf = view.fields.find((f) => f.field === node.field);
    if (!fieldDef) return null;

    const required = !!fieldDef.required && !isViewMode;
    const readonly = isFieldReadonly(node.field, fieldDef, node.readonly);

    return (
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

  return (
    <form id="auto-form" onSubmit={handleSubmit}>
      {/* Action buttons moved to page-level control panel */}

      {/* Layout nodes */}
      {layoutNodes.map((node, i) => (
        <div key={getNodeKey(node, i)}>{renderNode(node, 0)}</div>
      ))}

      {/* Footer */}
      {!isViewMode && !hideFooter && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-muted-foreground">
            {hasDirtyFields && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-blue-500" />
                {t("form.fieldModified")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
            )}
            <Button type="submit">
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
    case "ref":
      return null;
    default:
      return "";
  }
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
