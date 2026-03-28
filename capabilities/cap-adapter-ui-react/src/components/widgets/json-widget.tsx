import { Textarea } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";

export function JsonDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span className="text-xs text-muted-foreground">[JSON]</span>;
}

export function JsonInput({ value, onChange, onBlur, readonly, error, dirty }: WidgetInputProps) {
  return (
    <div className="space-y-1">
      <Textarea
        className={cn(
          "min-h-[120px] font-mono text-xs",
          dirty && !error && "border-ring",
          error && "border-destructive focus-visible:ring-destructive",
        )}
        value={
          value != null ? (typeof value === "string" ? value : JSON.stringify(value, null, 2)) : ""
        }
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            onChange(e.target.value);
          }
        }}
        onBlur={onBlur}
        disabled={readonly}
        aria-invalid={!!error}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
