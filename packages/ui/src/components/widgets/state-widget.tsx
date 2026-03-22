import { Badge } from "@linchkit/ui-kit/components";
import { resolveStateColor, type StateColorToken } from "@/lib/state-colors";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";

function tokenToBadgeVariant(token: StateColorToken): "default" | "secondary" | "destructive" {
  switch (token) {
    case "danger":
      return "destructive";
    case "secondary":
      return "secondary";
    default:
      return "default";
  }
}

export function StateDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground">&mdash;</span>;
  const token = resolveStateColor(String(value));
  return <Badge variant={tokenToBadgeVariant(token)}>{String(value)}</Badge>;
}

/** State fields are read-only — show as badge in input mode too */
export function StateInput({ value }: WidgetInputProps) {
  const token = resolveStateColor(value != null ? String(value) : "");
  return (
    <div className="pt-1">
      <Badge variant={tokenToBadgeVariant(token)}>{value != null ? String(value) : "—"}</Badge>
    </div>
  );
}
