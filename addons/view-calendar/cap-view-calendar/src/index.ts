/**
 * @linchkit/cap-view-calendar — public exports.
 *
 * Re-exports the capability descriptor, the React rendering surface, the
 * pure logic hook, and types so consumers can wire calendar views without
 * digging into the package internals.
 */

export { CalendarBoard } from "./CalendarBoard";
export { CalendarEvent, type CalendarEventProps } from "./CalendarEvent";
export { CalendarGrid, type CalendarGridProps } from "./CalendarGrid";
export { capViewCalendar } from "./capability";
export {
  DAY_DROPPABLE_PREFIX,
  dayDroppableId,
  parseDayDroppableId,
} from "./droppable-ids";
export type {
  CalendarBoardProps,
  CalendarDayCell,
  CalendarEventChip,
  CalendarRecord,
  CalendarViewMode,
} from "./types";
export {
  bucketChipsIntoCells,
  getCalendarRange,
  parseCalendarDate,
  toDayKey,
  toEventChips,
  useCalendarData,
} from "./use-calendar-data";
