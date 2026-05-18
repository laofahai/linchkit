/**
 * TimelineBoard — top-level Gantt/timeline view component.
 *
 * Composes TimelineGrid (column headers) + rows layer (one row per bar,
 * grouped when groupByField is provided). Navigation controls allow the
 * user to move the anchor date and switch between day / week / month modes.
 *
 * Layout strategy: the rows area uses a CSS relative container with the
 * header taking up a fixed left column (label) and the bar area filling
 * the remainder. Bars are absolutely positioned inside each row using
 * percentage-based left/width values from layoutBars().
 *
 * Spec 54 — Advanced UI Features (timeline view), Issue #86.
 */

"use client";

import { cn } from "@linchkit/ui-kit/lib/utils";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TimelineBarComponent } from "./TimelineBar";
import { TimelineGrid } from "./TimelineGrid";
import type { TimelineBoardProps, TimelineViewMode } from "./types";
import {
  addDays,
  buildBars,
  buildColumns,
  groupLayouts,
  layoutBars,
  startOfDay,
} from "./use-timeline-data";

const LABEL_COL_WIDTH = 160;

export function TimelineBoard({
  entity,
  startField,
  endField,
  labelField,
  groupByField,
  data,
  initialMode = "week",
  currentDate,
  onDateChange,
  loading = false,
  error = null,
  onBarClick,
  className,
}: TimelineBoardProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TimelineViewMode>(initialMode);
  const [anchorState, setAnchorState] = useState<Date>(() => startOfDay(currentDate ?? new Date()));
  const anchor = currentDate ? startOfDay(currentDate) : anchorState; // controlled when currentDate is provided

  const handleAnchorChange = useCallback(
    (d: Date) => {
      setAnchorState(d);
      onDateChange?.(d);
    },
    [onDateChange],
  );

  const navigate = useCallback(
    (direction: "prev" | "next") => {
      if (mode === "month") {
        const nextAnchor = new Date(anchor);
        nextAnchor.setMonth(nextAnchor.getMonth() + (direction === "next" ? 6 : -6));
        handleAnchorChange(nextAnchor);
      } else {
        const steps = { day: 7, week: 6 * 7 };
        const delta = (direction === "next" ? 1 : -1) * steps[mode as "day" | "week"];
        handleAnchorChange(addDays(anchor, delta));
      }
    },
    [anchor, mode, handleAnchorChange],
  );

  const goToday = useCallback(() => {
    handleAnchorChange(startOfDay(new Date()));
  }, [handleAnchorChange]);

  const columns = useMemo(() => buildColumns(anchor, mode), [anchor, mode]);

  const bars = useMemo(
    () => buildBars(data, startField, endField, labelField, groupByField),
    [data, startField, endField, labelField, groupByField],
  );

  const layouts = useMemo(() => layoutBars(bars, columns, mode), [bars, columns, mode]);

  const groups = useMemo(() => groupLayouts(layouts), [layouts]);

  // ── Error / loading states ──────────────────────────────────────────────
  if (error) {
    return <div className={cn("p-4 text-sm text-destructive", className)}>{error.message}</div>;
  }

  if (loading) {
    return (
      <div className={cn("flex flex-col gap-2 p-4", className)}>
        <div className="h-8 rounded bg-muted animate-pulse" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-10 rounded bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  // ── Toolbar ─────────────────────────────────────────────────────────────
  const modes: TimelineViewMode[] = ["day", "week", "month"];

  return (
    <div className={cn("flex flex-col border border-border rounded-md overflow-hidden", className)}>
      {/* toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30">
        <button
          type="button"
          onClick={() => navigate("prev")}
          className="px-2 py-1 text-sm rounded hover:bg-muted border border-border"
          aria-label={t("timeline.prev")}
        >
          ‹
        </button>
        <button
          type="button"
          onClick={goToday}
          className="px-2 py-1 text-sm rounded hover:bg-muted border border-border"
        >
          {t("timeline.today")}
        </button>
        <button
          type="button"
          onClick={() => navigate("next")}
          className="px-2 py-1 text-sm rounded hover:bg-muted border border-border"
          aria-label={t("timeline.next")}
        >
          ›
        </button>
        <span className="flex-1" />
        {/* mode switcher */}
        <div className="flex border border-border rounded overflow-hidden text-sm">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                "px-2 py-1",
                m === mode ? "bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              {t(`timeline.mode.${m}`)}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground ml-1">{entity}</span>
      </div>

      {/* scrollable board */}
      <div className="overflow-x-auto flex-1">
        <div style={{ minWidth: `${LABEL_COL_WIDTH + columns.length * 80}px` }}>
          {/* column headers */}
          <TimelineGrid columns={columns} labelColWidth={LABEL_COL_WIDTH} />

          {/* rows */}
          <div className="divide-y divide-border">
            {groups.map(({ group, layouts: groupLayouts }) => (
              <div key={group}>
                {/* group header — only when groupByField is set */}
                {groupByField && group !== "" && (
                  <div
                    className="sticky left-0 flex items-center px-3 py-1 text-xs font-semibold bg-muted/50 border-b border-border"
                    style={{ width: "100%" }}
                  >
                    {group}
                    <span className="ml-1 text-muted-foreground">
                      ({groupLayouts.filter((l) => l.widthFrac > 0).length})
                    </span>
                  </div>
                )}
                {/* record rows */}
                {groupLayouts.map((layout) => {
                  if (layout.widthFrac <= 0 && layout.leftFrac === 0 && !layout.overflowsLeft)
                    return null; // entirely out of window
                  return (
                    <div key={layout.bar.id} className="flex items-stretch min-h-[36px]">
                      {/* fixed label column */}
                      <div
                        className="flex-shrink-0 flex items-center px-3 text-sm truncate border-r border-border"
                        style={{ width: LABEL_COL_WIDTH }}
                        title={layout.bar.label}
                      >
                        {layout.bar.label}
                      </div>
                      {/* bar area — relative for absolute-positioned bar */}
                      <div className="relative flex-1 min-h-[36px]">
                        {/* column grid lines */}
                        {columns.map((col, idx) => (
                          <div
                            key={col.key}
                            className={cn(
                              "absolute top-0 bottom-0 border-r border-border/40",
                              col.isToday && "bg-blue-50/40 dark:bg-blue-950/20",
                            )}
                            style={{
                              left: `${(idx / columns.length) * 100}%`,
                              width: `${(1 / columns.length) * 100}%`,
                            }}
                          />
                        ))}
                        <TimelineBarComponent layout={layout} onClick={onBarClick} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

            {groups.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("timeline.empty")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
