/**
 * StatusBar — Odoo-style chevron/arrow status progression indicator.
 *
 * Displays states as a horizontal arrow chain. Three visual states:
 * - **Completed** (past): muted fill with check mark
 * - **Active** (current): colored fill using state machine semantic color
 * - **Future**: light outline, dimmed text
 *
 * Visual: [✓ Draft ▸][✓ Pending ▸][ Approved ▸][ Rejected ]
 */

import { cn } from "@linchkit/ui-kit/lib/utils";
import { Check } from "lucide-react";
import { resolveColorToken, type StateColorToken } from "@/lib/state-colors";

export interface StatusBarStep {
  value: string;
  label: string;
  /** Semantic color token (e.g. "success", "danger") or StateMeta.color value */
  color?: string;
}

export interface StatusBarProps {
  steps: StatusBarStep[];
  current: string;
  onStepClick?: (value: string) => void;
  className?: string;
}

/** Map color token → Tailwind classes for the active chevron */
const ACTIVE_CLASSES: Record<StateColorToken, string> = {
  default: "bg-primary/15 text-primary",
  secondary: "bg-muted-foreground/15 text-muted-foreground",
  success: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  warning: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  danger: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
};

export function StatusBar({ steps, current, onStepClick, className }: StatusBarProps) {
  const currentIndex = steps.findIndex((s) => s.value === current);

  return (
    <div className={cn("inline-flex items-stretch", className)}>
      {steps.map((step, i) => {
        const isActive = step.value === current;
        const isCompleted = i < currentIndex;
        const isFuture = i > currentIndex;
        const isFirst = i === 0;
        const isLast = i === steps.length - 1;

        // Resolve color for the active step
        const colorToken: StateColorToken = step.color
          ? resolveColorToken(step.color)
          : "default";

        let colorCls: string;
        if (isActive) {
          colorCls = ACTIVE_CLASSES[colorToken];
        } else if (isCompleted) {
          colorCls = "bg-muted-foreground/10 text-muted-foreground";
        } else {
          // Future: very light, almost empty
          colorCls = "bg-muted/50 text-muted-foreground/50";
        }

        const chevronSize = 8;
        let clipPath: string;
        if (isFirst && isLast) {
          clipPath = "none";
        } else if (isFirst) {
          clipPath = `polygon(0 0, calc(100% - ${chevronSize}px) 0, 100% 50%, calc(100% - ${chevronSize}px) 100%, 0 100%)`;
        } else if (isLast) {
          clipPath = `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${chevronSize}px 50%)`;
        } else {
          clipPath = `polygon(0 0, calc(100% - ${chevronSize}px) 0, 100% 50%, calc(100% - ${chevronSize}px) 100%, 0 100%, ${chevronSize}px 50%)`;
        }

        return (
          <button
            key={step.value}
            type="button"
            disabled={!onStepClick}
            className={cn(
              "relative inline-flex items-center justify-center gap-1 px-4 py-1 text-xs font-medium transition-colors whitespace-nowrap",
              !isFirst && "-ml-[4px]",
              colorCls,
              onStepClick && "cursor-pointer hover:opacity-80",
              !onStepClick && "cursor-default",
            )}
            style={{ clipPath }}
            onClick={() => onStepClick?.(step.value)}
          >
            {isCompleted && <Check className="size-3 shrink-0" />}
            {step.label}
          </button>
        );
      })}
    </div>
  );
}
