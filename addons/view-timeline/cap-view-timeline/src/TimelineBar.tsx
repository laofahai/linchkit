/**
 * TimelineBar — a single record rendered as a horizontal bar.
 *
 * Positioned absolutely inside the rows layer using percentage-based
 * left/width values computed by layoutBars(). Overflow indicators
 * (left/right arrow fragments) signal bars that extend beyond the window.
 */

import { cn } from "@linchkit/ui-kit/lib/utils";
import type { TimelineRecord } from "./types";
import type { BarLayout } from "./use-timeline-data";

export interface TimelineBarComponentProps {
  layout: BarLayout;
  onClick?: (record: TimelineRecord) => void;
  /** Colour class applied to the bar. Falls back to a default blue. */
  colorClass?: string;
}

export function TimelineBarComponent({
  layout,
  onClick,
  colorClass = "bg-blue-500 hover:bg-blue-600",
}: TimelineBarComponentProps) {
  const { bar, leftFrac, widthFrac, overflowsLeft, overflowsRight } = layout;

  // Invisible bars (out of window) — render nothing.
  if (widthFrac <= 0) return null;

  const leftPct = `${(leftFrac * 100).toFixed(3)}%`;
  const widthPct = `${(widthFrac * 100).toFixed(3)}%`;

  return (
    <button
      type="button"
      className={cn(
        "absolute top-1 h-6 rounded text-white text-xs flex items-center px-1 cursor-pointer select-none transition-colors truncate border-0 p-0",
        colorClass,
        overflowsLeft && "rounded-l-none",
        overflowsRight && "rounded-r-none",
      )}
      style={{ left: leftPct, width: widthPct }}
      title={bar.label}
      onClick={() => onClick?.(bar.record)}
    >
      {overflowsLeft && <span className="mr-0.5 flex-shrink-0">◀</span>}
      <span className="truncate">{bar.label}</span>
      {overflowsRight && <span className="ml-0.5 flex-shrink-0">▶</span>}
    </button>
  );
}
