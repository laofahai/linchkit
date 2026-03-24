import type { StateMeta } from "@linchkit/core/types";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { getStateBadgeClass, resolveStateColor } from "@/lib/state-colors";
import { useSchemaLabel } from "../../i18n/use-schema-label";

interface StatusBadgeProps {
  value: string;
  meta?: Partial<Record<string, StateMeta>>;
}

export function StatusBadge({ value, meta }: StatusBadgeProps) {
  const { resolveLabel } = useSchemaLabel();
  const token = resolveStateColor(value, meta);
  const colorClass = getStateBadgeClass(token);
  const fallback = value.charAt(0).toUpperCase() + value.slice(1);
  const label = resolveLabel(meta?.[value]?.label, fallback);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        colorClass,
      )}
    >
      {label}
    </span>
  );
}
