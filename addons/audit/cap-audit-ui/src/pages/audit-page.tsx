/**
 * Lazy-loaded admin route component for the audit log viewer.
 *
 * Imported indirectly through `registerAdminRoute(...)` in `index.ts`.
 */

import AuditList from "../views/AuditList";

export default function AuditPage() {
  return <AuditList />;
}
