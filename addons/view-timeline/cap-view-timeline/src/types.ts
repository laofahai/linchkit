/**
 * Public types for cap-view-timeline.
 *
 * Keeps the rendering layer decoupled from the host's entity layer — records
 * are plain key/value bags, identical to the pattern in cap-view-calendar.
 */

export type TimelineRecord = Record<string, unknown>;

/** Time axis granularity. Controls column width and header labels. */
export type TimelineViewMode = "day" | "week" | "month";

export interface TimelineBoardProps {
  /** Entity name — used for labelling only; timeline logic never touches the registry. */
  entity: string;
  /**
   * Field on each record holding the bar start date.
   * Accepts ISO string, Date instance, or millisecond epoch.
   */
  startField: string;
  /**
   * Field on each record holding the bar end date.
   * Accepts ISO string, Date instance, or millisecond epoch.
   * When missing, falls back to `startField` (single-day bar).
   */
  endField: string;
  /** Field rendered as the visible bar label. */
  labelField: string;
  /**
   * Optional field to group rows. Each distinct value gets its own row section
   * with a group header. When omitted, all records appear in a single flat list.
   */
  groupByField?: string;
  /** Records to place on the timeline. */
  data: TimelineRecord[];
  /** Initial time axis granularity (default: "week"). */
  initialMode?: TimelineViewMode;
  /** Controlled anchor date — the visible window centres around this date. */
  currentDate?: Date;
  /** Called when the user navigates to a new anchor date. */
  onDateChange?: (date: Date) => void;
  /** Loading flag — renders a skeleton state. */
  loading?: boolean;
  /** Error to surface in the error slot. */
  error?: Error | null;
  /** Click handler — fires when the user clicks a bar. */
  onBarClick?: (record: TimelineRecord) => void;
  /** Optional className applied to the outer wrapper. */
  className?: string;
}

/** A resolved bar that sits in the rendered grid. */
export interface TimelineBar {
  /** Stable id — sourced from `record.id` with string coercion. */
  id: string;
  /** Source record. */
  record: TimelineRecord;
  /** Resolved start (clamped to the visible window). */
  start: Date;
  /** Resolved end (always >= start). */
  end: Date;
  /** Display text. */
  label: string;
  /** Optional group key when `groupByField` is set. */
  group?: string;
}

/** A single column in the rendered header — one day, week, or month slot. */
export interface TimelineColumn {
  /** Unique key for React (ISO date string of the column start). */
  key: string;
  /** Midnight of the column's opening moment. */
  date: Date;
  /** Human-readable header label (e.g. "Mon 18", "W21", "May"). */
  label: string;
  /** Whether this column contains today — used for the "now" highlight. */
  isToday: boolean;
}
