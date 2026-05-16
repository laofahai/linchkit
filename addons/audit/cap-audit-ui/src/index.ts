/**
 * Entry point for cap-audit-ui.
 *
 * Registers the audit log admin route. Imported by the host UI bundle
 * (cap-adapter-ui) to wire the capability into the admin layout.
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
export { default as AuditDetailView } from "./views/AuditDetail";
export { AuditFiltersBar } from "./views/AuditFilters";
export { default as AuditList } from "./views/AuditList";

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
