import type { StateMeta } from "@linchkit/core";
import { cn } from "@/lib/utils";
import { getStateBadgeClass, resolveStateColor } from "@/lib/state-colors";

interface StatusBadgeProps {
  value: string;
  meta?: Partial<Record<string, StateMeta>>;
}

export function StatusBadge({ value, meta }: StatusBadgeProps) {
  const token = resolveStateColor(value, meta);
  const colorClass = getStateBadgeClass(token);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        colorClass,
      )}
    >
      {meta?.[value]?.label ?? value.charAt(0).toUpperCase() + value.slice(1)}
    </span>
  );
}
