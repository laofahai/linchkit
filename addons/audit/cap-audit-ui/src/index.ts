/**
 * Entry point for cap-audit-ui.
 *
 * Registers the audit log admin route + the event timeline admin route.
 * Imported by the host UI bundle (cap-adapter-ui) to wire the capability
 * into the admin layout.
 */

import { registerAdminRoute } from "@linchkit/cap-adapter-ui/route-registry";

export { capAuditUi } from "./capability";
export type {
  AuditDetail,
  AuditFilters,
  AuditListResult,
  AuditRow,
  AuditStatus,
} from "./lib/audit-api";
export { AUDIT_STATUSES, queryAuditDetail, queryAuditList } from "./lib/audit-api";
export type {
  EventListOptions,
  EventListResult,
  EventStatus,
  EventSummary,
  HandlerHistoryEntry,
  ReplayEventOptions,
  ReplayHandlerOutcome,
  ReplayReport,
} from "./lib/eventsClient";
export {
  getHandlerHistory,
  list as listEvents,
  replayEvent,
} from "./lib/eventsClient";
export { default as AuditDetailView } from "./views/AuditDetail";
export { AuditFiltersBar } from "./views/AuditFilters";
export { default as AuditList } from "./views/AuditList";
export { default as EventHandlersPanel, truncateError } from "./views/EventHandlersPanel";
export { default as EventReplayDialog } from "./views/EventReplayDialog";
export { default as EventTimeline, formatTimestamp } from "./views/EventTimeline";

registerAdminRoute({
  id: "audit",
  capability: "cap-audit-ui",
  path: "/admin/audit",
  label: "audit.list.title",
  icon: "ScrollText",
  // Sit just after the placeholder builtin executions route (order 100)
  // so existing nav order is preserved while we transition.
  order: 110,
  component: () => import("./pages/audit-page"),
});

registerAdminRoute({
  id: "events",
  capability: "cap-audit-ui",
  path: "/admin/events",
  label: "events.timeline.title",
  icon: "Activity",
  // Sit immediately after the audit route so the two related views
  // appear side by side in the admin nav.
  order: 111,
  component: () => import("./pages/EventsPage"),
});
