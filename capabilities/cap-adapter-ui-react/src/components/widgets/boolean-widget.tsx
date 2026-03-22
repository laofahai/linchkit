import { Switch } from "@linchkit/ui-kit/components";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";

export function BooleanDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span className="text-sm">{value ? "Yes" : "No"}</span>;
}

export function BooleanInput({ value, onChange, readonly, error }: WidgetInputProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 pt-1">
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked)}
          disabled={readonly}
        />
        <span className="text-sm text-muted-foreground">{value ? "Yes" : "No"}</span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
