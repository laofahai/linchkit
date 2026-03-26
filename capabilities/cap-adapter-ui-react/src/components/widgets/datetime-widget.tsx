import { Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { formatDateTime, requiredBg, toDateTimeInputValue } from "./utils";

export function DateTimeDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span>{formatDateTime(value)}</span>;
}

export function DateTimeInput({
  value,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  return (
    <div className="space-y-1">
      <Input
        type="datetime-local"
        value={value != null ? toDateTimeInputValue(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        aria-invalid={!!error}
        className={cn(required && requiredBg, dirty && !error && "border-ring")}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
