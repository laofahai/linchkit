/**
 * ActionProposalCard — AI-resolved action confirmation card.
 *
 * Displayed in the AI Assistant chat when an intent is resolved.
 * Shows the matched action, pre-filled input values in editable fields,
 * confidence score, and Execute/Cancel buttons.
 *
 * AI proposes, user confirms — never auto-execute.
 */

import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import { AlertTriangleIcon, CheckCircle2Icon, Loader2Icon, PlayIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ActionResult, IntentFieldSchema, IntentResolution } from "../lib/api";
import { executeAction } from "../lib/api";

// ── Types ────────────────────────────────────────────────

export type ProposalStatus = "pending" | "executing" | "success" | "error" | "cancelled";

export interface ActionProposalCardProps {
  intent: IntentResolution;
  onComplete?: (result: ActionResult) => void;
  onCancel?: () => void;
}

function resolveTranslatableLabel(
  raw: string | undefined,
  fallback: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!raw) return fallback;
  if (raw.startsWith("t:")) {
    return t(raw.slice(2), { defaultValue: fallback });
  }
  return raw;
}

// ── Field Editor ────────────────────────────────────────

function FieldEditor({
  name,
  schema,
  value,
  onChange,
  disabled,
}: {
  name: string;
  schema: IntentFieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const label = resolveTranslatableLabel(schema.label, name, t);

  // Enum/select field
  if (schema.options && schema.options.length > 0) {
    return (
      <div className="space-y-1">
        <Label className="text-xs font-medium">
          {label}
          {schema.required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        <Select value={String(value ?? "")} onValueChange={(v) => onChange(v)} disabled={disabled}>
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {schema.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {resolveTranslatableLabel(opt.label, opt.value, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  // Number field
  if (schema.type === "number") {
    return (
      <div className="space-y-1">
        <Label className="text-xs font-medium">
          {label}
          {schema.required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
        <Input
          type="number"
          className="h-7 text-xs"
          value={value != null ? String(value) : ""}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
          disabled={disabled}
        />
      </div>
    );
  }

  // Boolean field
  if (schema.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          className="size-3.5"
        />
        <Label className="text-xs font-medium">
          {label}
          {schema.required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
      </div>
    );
  }

  // Default: string/text input
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium">
        {label}
        {schema.required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      <Input
        className="h-7 text-xs"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={disabled}
      />
    </div>
  );
}

// ── Confidence badge ────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const variant = confidence >= 0.8 ? "default" : confidence >= 0.5 ? "secondary" : "destructive";
  return (
    <Badge variant={variant} className="text-[10px]">
      {pct}%
    </Badge>
  );
}

// ── Main component ──────────────────────────────────────

export function ActionProposalCard({ intent, onComplete, onCancel }: ActionProposalCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ProposalStatus>("pending");
  const [editedInput, setEditedInput] = useState<Record<string, unknown>>({ ...intent.input });
  const [_result, setResult] = useState<ActionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFieldChange = useCallback((field: string, value: unknown) => {
    setEditedInput((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleExecute = useCallback(async () => {
    setStatus("executing");
    setErrorMessage(null);

    try {
      const actionResult = await executeAction(intent.action, editedInput);
      setResult(actionResult);

      if (actionResult.success) {
        setStatus("success");
      } else {
        setStatus("error");
        setErrorMessage(actionResult.error?.message ?? t("ai.actionExecFailed"));
      }

      onComplete?.(actionResult);
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : t("ai.actionExecFailed"));
    }
  }, [intent.action, editedInput, onComplete, t]);

  const handleCancel = useCallback(() => {
    setStatus("cancelled");
    onCancel?.();
  }, [onCancel]);

  const isEditable = status === "pending";
  const inputFields = Object.entries(intent.inputSchema);
  const actionLabel = resolveTranslatableLabel(intent.actionLabel, intent.action, t);

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      {/* Header */}
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <PlayIcon className="size-3 text-primary" />
            <span className="text-xs font-semibold">{actionLabel}</span>
          </div>
          <ConfidenceBadge confidence={intent.confidence} />
        </div>
        {intent.actionDescription && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{intent.actionDescription}</p>
        )}
      </div>

      {/* Explanation */}
      <div className="border-b px-3 py-2">
        <p className="text-xs text-muted-foreground">{intent.explanation}</p>
      </div>

      {/* Input fields */}
      {inputFields.length > 0 && (
        <div className="space-y-2 px-3 py-2">
          {inputFields.map(([fieldName, fieldSchema]) => (
            <FieldEditor
              key={fieldName}
              name={fieldName}
              schema={fieldSchema}
              value={editedInput[fieldName]}
              onChange={(v) => handleFieldChange(fieldName, v)}
              disabled={!isEditable}
            />
          ))}
        </div>
      )}

      {/* Missing fields warning */}
      {intent.missingFields.length > 0 && status === "pending" && (
        <div className="flex items-start gap-1.5 border-t px-3 py-2">
          <AlertTriangleIcon className="mt-0.5 size-3 text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-600">
            {t("ai.missingFields")}: {intent.missingFields.join(", ")}
          </p>
        </div>
      )}

      {/* Result display */}
      {status === "success" && (
        <div className="flex items-start gap-1.5 border-t px-3 py-2">
          <CheckCircle2Icon className="mt-0.5 size-3 text-green-600 shrink-0" />
          <p className="text-[11px] text-green-700">{t("ai.actionSuccess")}</p>
        </div>
      )}
      {status === "error" && errorMessage && (
        <div className="flex items-start gap-1.5 border-t px-3 py-2">
          <AlertTriangleIcon className="mt-0.5 size-3 text-destructive shrink-0" />
          <p className="text-[11px] text-destructive">{errorMessage}</p>
        </div>
      )}
      {status === "cancelled" && (
        <div className="border-t px-3 py-2">
          <p className="text-[11px] text-muted-foreground">{t("ai.actionCancelled")}</p>
        </div>
      )}

      {/* Action buttons */}
      {status === "pending" && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleCancel}>
            <XIcon className="mr-1 size-3" />
            {t("common.cancel")}
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={handleExecute}>
            <PlayIcon className="mr-1 size-3" />
            {t("ai.executeAction")}
          </Button>
        </div>
      )}
      {status === "executing" && (
        <div className="flex items-center justify-center gap-2 border-t px-3 py-2">
          <Loader2Icon className="size-3.5 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">{t("ai.executing")}</span>
        </div>
      )}
    </div>
  );
}
