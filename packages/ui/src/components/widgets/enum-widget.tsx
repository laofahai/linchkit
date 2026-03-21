import type { EnumField } from "@linchkit/core";
import { cn } from "@/lib/utils";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { Badge } from "../ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { requiredBg } from "./utils";

export function EnumDisplay({ value, fieldDef }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  const enumDef = fieldDef as EnumField;
  const option = enumDef.options?.find((o) => o.value === value);
  const label = option?.label ?? String(value);
  return <Badge variant="outline">{label}</Badge>;
}

export function EnumInput({ value, fieldDef, onChange, onBlur, readonly, error, dirty, required }: WidgetInputProps) {
  const enumDef = fieldDef as EnumField;
  return (
    <div className="space-y-1">
      <Select
        value={value != null ? String(value) : undefined}
        onValueChange={(val) => onChange(val)}
        disabled={readonly}
      >
        <SelectTrigger
          className={cn(
            required && requiredBg,
            dirty && !error && "border-blue-300",
            error && "border-destructive",
          )}
          onBlur={onBlur}
        >
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          {enumDef.options?.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label ?? opt.value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
