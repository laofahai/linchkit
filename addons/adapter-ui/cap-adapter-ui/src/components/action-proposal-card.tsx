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
import type {
  ActionResult,
  IntentAlternative,
  IntentFieldSchema,
  IntentResolution,
} from "../lib/api";
import { executeAction } from "../lib/api";

// ── Types ────────────────────────────────────────────────

export type ProposalStatus = "pending" | "executing" | "success" | "error" | "cancelled";

export interface ActionProposalCardProps {
  intent: IntentResolution;
  onComplete?: (result: ActionResult) => void;
  onCancel?: () => void;
}

/** Maximum number of alternatives to render in the "Did you mean" section. */
export const MAX_DISPLAYED_ALTERNATIVES = 3;

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

// ── Pure swap helper (exported for unit testing) ─────────

/**
 * Swap an alternative at the given index into the primary slot.
 *
 * Returns a new `IntentResolution` whose primary is the chosen alternative
 * and whose alternatives list contains:
 *   - the previous primary (now reversible — the user can swap back),
 *   - all other previous alternatives, in original order.
 *
 * Reversibility: the previous primary's display metadata (`schema`,
 * `actionLabel`, `actionDescription`, `inputSchema`) is preserved on the
 * demoted `IntentAlternative` so swapping BACK to it later restores a
 * fully-rendered card with editable fields.
 *
 * Server-returned alternatives carry no display metadata (the route only
 * enriches the primary). When such an alternative is swapped IN, we surface
 * placeholders (`actionLabel = action`, empty `inputSchema`) — the AI-
 * extracted `input` is still shown as a read-only summary; field editing
 * unlocks on the next round-trip when the user re-prompts.
 *
 * Returns `null` when `index` is out of range so callers can no-op safely.
 */
export function swapAlternative(current: IntentResolution, index: number): IntentResolution | null {
  const alternatives = current.alternatives ?? [];
  if (index < 0 || index >= alternatives.length) return null;

  const chosen = alternatives[index];
  if (!chosen) return null;

  // Demote the previous primary into an alternative entry, preserving its
  // display metadata so a future swap-back is non-lossy.
  const previousPrimary: IntentAlternative = {
    action: current.action,
    input: current.input,
    confidence: current.confidence,
    missingFields: current.missingFields,
    explanation: current.explanation,
    schema: current.schema,
    actionLabel: current.actionLabel,
    actionDescription: current.actionDescription,
    inputSchema: current.inputSchema,
  };

  // New alternatives = [previousPrimary, ...alternatives without chosen].
  // Sort DESC by confidence so the highest-confidence alternative renders
  // first regardless of swap history.
  const remaining = alternatives.filter((_, i) => i !== index);
  const nextAlternatives = [previousPrimary, ...remaining].sort(
    (a, b) => b.confidence - a.confidence,
  );

  return {
    action: chosen.action,
    schema: chosen.schema ?? chosen.action,
    input: chosen.input,
    missingFields: chosen.missingFields,
    confidence: chosen.confidence,
    explanation: chosen.explanation,
    actionLabel: chosen.actionLabel ?? chosen.action,
    actionDescription: chosen.actionDescription,
    inputSchema: chosen.inputSchema ?? {},
    alternatives: nextAlternatives,
  };
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

/**
 * Format a confidence score (0-1) as a percentage string. Defensive against
 * NaN/Infinity/undefined that could leak from a malformed AI response —
 * returns "—" instead of "NaN%" in those cases.
 */
function formatConfidencePct(confidence: number): string {
  if (!Number.isFinite(confidence)) return "—";
  return `${Math.round(confidence * 100)}%`;
}

function confidenceBadgeVariant(confidence: number): "default" | "secondary" | "destructive" {
  if (!Number.isFinite(confidence) || confidence < 0.5) return "destructive";
  if (confidence >= 0.8) return "default";
  return "secondary";
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  return (
    <Badge variant={confidenceBadgeVariant(confidence)} className="text-[10px]">
      {formatConfidencePct(confidence)}
    </Badge>
  );
}

// ── Main component ──────────────────────────────────────

export function ActionProposalCard({ intent, onComplete, onCancel }: ActionProposalCardProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ProposalStatus>("pending");
  // Track current intent in state so alternatives can be swapped into the
  // primary slot without a server round-trip. Initialized from the prop on
  // first render only — subsequent prop changes are ignored to avoid clobbering
  // user-driven swaps.
  const [currentIntent, setCurrentIntent] = useState<IntentResolution>(intent);
  const [editedInput, setEditedInput] = useState<Record<string, unknown>>({ ...intent.input });
  const [_result, setResult] = useState<ActionResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFieldChange = useCallback((field: string, value: unknown) => {
    setEditedInput((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleSwapAlternative = useCallback((index: number) => {
    setCurrentIntent((prev) => {
      const next = swapAlternative(prev, index);
      if (!next) return prev;
      // Reset edited inputs to the chosen alternative's AI-extracted inputs.
      setEditedInput({ ...next.input });
      setErrorMessage(null);
      return next;
    });
  }, []);

  const handleExecute = useCallback(async () => {
    setStatus("executing");
    setErrorMessage(null);

    try {
      const actionResult = await executeAction(currentIntent.action, editedInput);
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
  }, [currentIntent.action, editedInput, onComplete, t]);

  const handleCancel = useCallback(() => {
    setStatus("cancelled");
    onCancel?.();
  }, [onCancel]);

  const isEditable = status === "pending";
  const inputFields = Object.entries(currentIntent.inputSchema);
  const actionLabel = resolveTranslatableLabel(currentIntent.actionLabel, currentIntent.action, t);

  // Defensive sort + cap — backend already returns sorted N-best, but this
  // guarantees the contract when swap mutates the list.
  const displayedAlternatives = (currentIntent.alternatives ?? [])
    .slice()
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_DISPLAYED_ALTERNATIVES);

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
      {/* Header */}
      <div className="border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <PlayIcon className="size-3 text-primary" />
            <span className="text-xs font-semibold">{actionLabel}</span>
          </div>
          <ConfidenceBadge confidence={currentIntent.confidence} />
        </div>
        {currentIntent.actionDescription && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {currentIntent.actionDescription}
          </p>
        )}
      </div>

      {/* Explanation */}
      <div className="border-b px-3 py-2">
        <p className="text-xs text-muted-foreground">{currentIntent.explanation}</p>
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
      {currentIntent.missingFields.length > 0 && status === "pending" && (
        <div className="flex items-start gap-1.5 border-t px-3 py-2">
          <AlertTriangleIcon className="mt-0.5 size-3 text-amber-500 shrink-0" />
          <p className="text-[11px] text-amber-600">
            {t("ai.missingFields")}: {currentIntent.missingFields.join(", ")}
          </p>
        </div>
      )}

      {/* Alternatives — "Did you mean" pills, only while pending */}
      {displayedAlternatives.length > 0 && status === "pending" && (
        <div className="border-t px-3 py-2" data-testid="proposal-alternatives">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("ai.didYouMean")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {displayedAlternatives.map((alt, index) => {
              const altLabel = resolveTranslatableLabel(alt.actionLabel, alt.action, t);
              return (
                <button
                  key={alt.action}
                  type="button"
                  data-testid="proposal-alternative-pill"
                  data-action={alt.action}
                  onClick={() => handleSwapAlternative(index)}
                  aria-label={t("ai.swapAction", {
                    action: altLabel,
                    pct: formatConfidencePct(alt.confidence),
                    defaultValue: `Switch to ${altLabel} (${formatConfidencePct(alt.confidence)})`,
                  })}
                  className="flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] transition-colors hover:bg-accent"
                  title={alt.explanation}
                >
                  <span>{altLabel}</span>
                  <Badge variant={confidenceBadgeVariant(alt.confidence)} className="text-[10px]">
                    {formatConfidencePct(alt.confidence)}
                  </Badge>
                </button>
              );
            })}
          </div>
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
