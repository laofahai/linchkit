import { Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { formatDate, requiredBg, toDateInputValue } from "./utils";

export function DateDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span>{formatDate(value)}</span>;
}

export function DateInput({
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
        type="date"
        value={value != null ? toDateInputValue(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        aria-invalid={!!error}
        className={cn(required && requiredBg, dirty && !error && "border-blue-300")}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
