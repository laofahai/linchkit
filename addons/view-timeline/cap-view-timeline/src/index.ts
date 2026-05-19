/**
 * Public entry point for @linchkit/cap-view-timeline.
 *
 * Exports the React components, data helpers, types, and capability metadata.
 * The `./i18n` import is side-effect-only — it registers the capability's
 * locale bundles into the shared react-i18next instance before any component
 * renders.
 */

import "./i18n";

export { capViewTimeline } from "./capability";
export { registerTimelineI18nResources } from "./i18n";
export { TimelineBarComponent } from "./TimelineBar";
export { TimelineBoard } from "./TimelineBoard";
export { TimelineGrid } from "./TimelineGrid";
export type {
  TimelineBar,
  TimelineBoardProps,
  TimelineColumn,
  TimelineRecord,
  TimelineViewMode,
} from "./types";
export type { BarLayout } from "./use-timeline-data";
export {
  addDays,
  buildBars,
  buildColumns,
  diffDays,
  groupLayouts,
  layoutBars,
  parseDate,
  startOfDay,
  startOfMonth,
  startOfWeek,
  windowEnd,
  windowStart,
} from "./use-timeline-data";
