import { Button, Separator } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { ReactNode } from "react";

export interface ViewOption {
  key: string;
  icon: ReactNode;
  label: string;
}

export interface ViewToggleConfig {
  options: ViewOption[];
  activeView: string;
  onViewChange: (view: string) => void;
  /** Extra controls rendered before the view buttons (e.g. calendar navigation). */
  extraControls?: ReactNode;
}

/**
 * ViewToggle — Segmented control for switching between list/kanban/calendar/tree views.
 *
 * Supports an optional `extraControls` slot that renders view-specific controls
 * (e.g. calendar month navigation) inline before the view mode buttons, separated
 * by a vertical divider for visual cohesion.
 */
export function ViewToggle({ options, activeView, onViewChange, extraControls }: ViewToggleConfig) {
  if (options.length === 0 && !extraControls) return null;

  return (
    <div className="flex items-center gap-1">
      {extraControls}
      {extraControls && options.length > 0 && (
        <Separator
          orientation="vertical"
          className="mx-0.5 h-4 data-[orientation=vertical]:self-center"
        />
      )}
      {options.map((opt) => (
        <Button
          key={opt.key}
          variant="ghost"
          size="icon-sm"
          className={cn(
            "h-7 w-7",
            activeView === opt.key
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => onViewChange(opt.key)}
          title={opt.label}
        >
          {opt.icon}
        </Button>
      ))}
    </div>
  );
}
