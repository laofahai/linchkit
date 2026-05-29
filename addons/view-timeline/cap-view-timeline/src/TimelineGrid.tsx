/**
 * TimelineGrid — column header row for the timeline board.
 *
 * Renders one header cell per TimelineColumn. The "today" column
 * receives a distinct background to orient the user in time.
 */

import { cn } from "@linchkit/ui-kit/lib/utils";
import type { TimelineColumn } from "./types";

export interface TimelineGridProps {
  columns: TimelineColumn[];
  /** Pixel width of the fixed left label column. */
  labelColWidth?: number;
}

export function TimelineGrid({ columns, labelColWidth = 160 }: TimelineGridProps) {
  return (
    <div className="flex border-b border-border text-xs font-medium text-muted-foreground sticky top-0 bg-background z-10">
      {/* label column placeholder */}
      <div className="flex-shrink-0 border-r border-border" style={{ width: labelColWidth }} />
      {/* column headers */}
      {columns.map((col) => (
        <div
          key={col.key}
          className={cn(
            "flex-1 text-center py-1 border-r border-border last:border-r-0 truncate",
            col.isToday && "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300",
          )}
        >
          {col.label}
        </div>
      ))}
    </div>
  );
}
