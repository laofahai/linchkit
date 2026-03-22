import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";

export function RefDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span className="font-mono text-xs text-muted-foreground">{String(value)}</span>;
}

export function RefInput({ value, onChange, onBlur, readonly, error, dirty }: WidgetInputProps) {
  return (
    <div className="space-y-1">
      <Select
        value={value != null ? String(value) : undefined}
        onValueChange={(val) => onChange(val)}
        disabled={readonly}
      >
        <SelectTrigger
          className={cn(
            "font-mono text-xs",
            dirty && !error && "border-blue-300",
            error && "border-destructive",
          )}
          onBlur={onBlur}
        >
          <SelectValue placeholder="Select reference..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none" disabled>
            No data available
          </SelectItem>
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
