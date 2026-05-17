/**
 * Public types for cap-view-calendar.
 *
 * Keeps the rendering layer (CalendarBoard / CalendarGrid) decoupled from
 * the host's entity layer — records are plain key/value bags.
 */

export type CalendarRecord = Record<string, unknown>;

/** Calendar display granularity. */
export type CalendarViewMode = "month" | "week" | "day";

export interface CalendarBoardProps {
  /** Entity name (used purely for keying / labelling — calendar logic never touches the registry). */
  entity: string;
  /** Field on each record holding the start date. ISO string, Date, or epoch ms. */
  dateField: string;
  /** Optional field holding the end date for multi-day events. */
  endDateField?: string;
  /** Field rendered as the visible event title. */
  titleField: string;
  /** Records to place on the calendar. */
  data: CalendarRecord[];
  /** Initial view mode (default: "month"). */
  initialMode?: CalendarViewMode;
  /** Controlled current date — defaults to today on first render. */
  currentDate?: Date;
  /** Called when the user navigates to a new reference date. */
  onDateChange?: (date: Date) => void;
  /** Loading flag — renders skeleton state. */
  loading?: boolean;
  /** Error to surface in the error slot. */
  error?: Error | null;
  /** Click handler — fires when the user clicks an event chip. */
  onEventClick?: (record: CalendarRecord) => void;
  /** Drag handler — fires after the user drops an event on a new day. */
  onMoveEvent?: (record: CalendarRecord, newDate: Date) => void;
}

export interface CalendarEventChip {
  /** Stable id used as React key + drag id. Sourced directly from `record.id`. */
  id: string;
  /** Source record. */
  record: CalendarRecord;
  /** Resolved start date. */
  start: Date;
  /** Resolved end date — equals start for single-day events. */
  end: Date;
  /** Title text rendered on the chip. */
  title: string;
}

/** One cell in the rendered grid — a single day with its events. */
export interface CalendarDayCell {
  /** Local-date string in yyyy-MM-dd, used as React key. */
  key: string;
  /** Midnight in local time of the represented day. */
  date: Date;
  /** Events overlapping this day. Ordered by start ascending. */
  events: CalendarEventChip[];
  /** Whether the day belongs to the focal month (only meaningful for month view). */
  inFocalMonth: boolean;
}
