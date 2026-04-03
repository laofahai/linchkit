/**
 * CalendarNavControls — Compact month navigation for use in toolbars.
 *
 * Designed to be rendered inside ViewToggle's `extraControls` slot so that
 * calendar navigation appears inline with the view mode switcher buttons.
 */

import { Button } from "@linchkit/ui-kit/components";
import { addMonths, format, startOfMonth, subMonths } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface CalendarNavControlsProps {
  currentMonth: Date;
  onMonthChange: (month: Date) => void;
}

export function CalendarNavControls({ currentMonth, onMonthChange }: CalendarNavControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs font-medium"
        onClick={() => {
          onMonthChange(startOfMonth(new Date()));
        }}
      >
        {t("calendar.today", "Today")}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6"
        onClick={() => onMonthChange(subMonths(currentMonth, 1))}
      >
        <ChevronLeft className="size-3.5" />
      </Button>
      <span className="min-w-[100px] text-center text-xs font-medium">
        {format(currentMonth, "MMM yyyy")}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6"
        onClick={() => onMonthChange(addMonths(currentMonth, 1))}
      >
        <ChevronRight className="size-3.5" />
      </Button>
    </div>
  );
}
