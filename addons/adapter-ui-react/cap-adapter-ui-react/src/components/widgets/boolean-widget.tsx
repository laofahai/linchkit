import { Switch } from "@linchkit/ui-kit/components";
import { useTranslation } from "react-i18next";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";

export function BooleanDisplay({ value }: WidgetDisplayProps) {
  const { t } = useTranslation();
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  return <span className="text-sm">{value ? t("common.yes", "Yes") : t("common.no", "No")}</span>;
}

export function BooleanInput({ value, onChange, readonly, error }: WidgetInputProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 pt-1">
        <Switch
          checked={Boolean(value)}
          onCheckedChange={(checked) => onChange(checked)}
          disabled={readonly}
        />
        <span className="text-sm text-muted-foreground">
          {value ? t("common.yes", "Yes") : t("common.no", "No")}
        </span>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
