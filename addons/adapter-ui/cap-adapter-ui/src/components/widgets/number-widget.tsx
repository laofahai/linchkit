import { Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useSchemaLabel } from "@/i18n/use-entity-label";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { formatCurrency, requiredBg } from "./utils";

export function NumberDisplay({ value, fieldDef }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  const formatted =
    fieldDef.ui?.format === "currency"
      ? formatCurrency(Number(value))
      : Number(value).toLocaleString();
  return <span className="tabular-nums">{formatted}</span>;
}

export function NumberInput({
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  const { resolveLabel } = useSchemaLabel();
  const resolvedLabel = fieldDef.label ? resolveLabel(fieldDef.label, fieldDef.label) : undefined;
  const placeholder =
    fieldDef.description ?? (resolvedLabel ? `Enter ${resolvedLabel.toLowerCase()}` : "0");
  return (
    <div className="space-y-1">
      <Input
        type="number"
        className={cn(
          "tabular-nums",
          required && requiredBg,
          dirty && !error && "border-ring",
          error && "border-destructive focus-visible:ring-destructive",
        )}
        value={value != null ? Number(value) : ""}
        onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        onBlur={onBlur}
        disabled={readonly}
        placeholder={placeholder}
        aria-invalid={!!error}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
