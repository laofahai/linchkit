import { Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { requiredBg } from "./utils";

export function StringDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span className="truncate">{String(value)}</span>;
}

export function StringInput({
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  const placeholder =
    fieldDef.description ?? (fieldDef.label ? `Enter ${fieldDef.label.toLowerCase()}` : undefined);
  return (
    <div className="space-y-1">
      <Input
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        placeholder={placeholder}
        aria-invalid={!!error}
        className={cn(required && requiredBg, dirty && !error && "border-blue-300")}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
