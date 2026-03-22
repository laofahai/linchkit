/**
 * StatusBar — Chevron status indicator.
 *
 * Uses clip-path for arrow shapes. Background stripe behind all steps
 * provides visual continuity, with the active step highlighted.
 * Colors are resolved from state-colors utility for consistency.
 */

import { cn } from "@linchkit/ui-kit/lib/utils";
import { getStateBarClass, resolveColorToken, type StateColorToken } from "@/lib/state-colors";

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

export function StatusBar({ steps, current, onStepClick, className }: StatusBarProps) {
  const currentIndex = steps.findIndex((s) => s.value === current);
  const currentStep = steps[currentIndex];
  const activeColorToken: StateColorToken = currentStep?.color
    ? resolveColorToken(currentStep.color)
    : "default";

  return (
    <div className={cn("inline-flex items-stretch rounded bg-muted", className)}>
      {steps.map((step, i) => {
        const isActive = step.value === current;
        const isCompleted = i < currentIndex;
        const isFirst = i === 0;
        const isLast = i === steps.length - 1;

        let colorCls: string;
        if (isActive) {
          colorCls = getStateBarClass(activeColorToken);
        } else if (isCompleted) {
          colorCls = "bg-muted-foreground/15 text-foreground";
        } else {
          colorCls = "bg-muted text-muted-foreground";
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
              "relative px-4 py-1 text-xs font-medium transition-colors",
              !isFirst && "-ml-[4px]",
              colorCls,
              onStepClick && "cursor-pointer hover:opacity-80",
              !onStepClick && "cursor-default",
            )}
            style={{ clipPath }}
            onClick={() => onStepClick?.(step.value)}
          >
            {step.label}
          </button>
        );
      })}
    </div>
  );
}
