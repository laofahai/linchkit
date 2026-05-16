/**
 * Capability definition for cap-audit-ui.
 *
 * Provides the Audit Log Viewer admin pages — a list of every Action
 * execution recorded in `_linchkit.executions`, with filters and a
 * detail drawer showing input/output/rules/state-transitions for one
 * execution.
 *
 * Backend data source: existing `executionLogList` GraphQL query
 * (registered by `cap-adapter-server` against the `execution_log`
 * system entity). This capability is read-only and does NOT query
 * the `_linchkit.executions` table directly.
 *
 * Issue: #138
 * Spec: 14 (System Capabilities), 11 (Execution Log)
 */

import { defineCapability } from "@linchkit/core";

export const capAuditUi = defineCapability({
  name: "cap-audit-ui",
  label: "Audit Log Viewer UI",
  description:
    "Admin UI for browsing the execution log — list, filter (action/actor/status/date/entity), and inspect a single execution's full input/output/rules/state-transitions.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "audit",
  dependencies: ["cap-adapter-ui"],
  autoInstall: true,
});
