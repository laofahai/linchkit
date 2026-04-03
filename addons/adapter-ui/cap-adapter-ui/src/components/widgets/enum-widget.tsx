import type { EnumField } from "@linchkit/core/types";
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useTranslation } from "react-i18next";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { useSchemaLabel } from "../../i18n/use-entity-label";
import { requiredBg } from "./utils";

export function EnumDisplay({ value, fieldDef }: WidgetDisplayProps) {
  const { resolveLabel } = useSchemaLabel();
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  const enumDef = fieldDef as EnumField;
  const option = enumDef.options?.find((o) => o.value === value);
  const label = resolveLabel(option?.label, String(value));
  return <Badge variant="outline">{label}</Badge>;
}

export function EnumInput({
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();
  const enumDef = fieldDef as EnumField;
  return (
    <div className="space-y-1">
      <Select
        value={value != null && value !== "" ? String(value) : undefined}
        onValueChange={(val) => onChange(val)}
        disabled={readonly}
      >
        <SelectTrigger
          className={cn(
            required && requiredBg,
            dirty && !error && "border-ring",
            error && "border-destructive focus-visible:ring-destructive",
          )}
          onBlur={onBlur}
        >
          <SelectValue placeholder={t("common.select", "Select...")} />
        </SelectTrigger>
        <SelectContent>
          {enumDef.options?.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {resolveLabel(opt.label, opt.value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
