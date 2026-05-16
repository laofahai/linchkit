/**
 * Capability definition for cap-audit-ui.
 *
 * Provides two admin pages:
 *  - Audit Log Viewer — every Action execution recorded in
 *    `_linchkit.executions`, with filters and a detail drawer showing
 *    input/output/rules/state-transitions for one execution.
 *  - Event Timeline + Replay — every domain event recorded in
 *    `_linchkit.events`, with per-handler delivery state and a
 *    confirmation-gated replay dialog (dry-run by default).
 *
 * Backend data source: the existing `executionLogList` GraphQL query
 * (registered by `cap-adapter-server` against the `execution_log`
 * system entity) plus the event GraphQL surface that fronts
 * `eventReplayService` from `@linchkit/core`. This capability is
 * read-mostly — replays go through the dedicated mutation, never
 * direct table writes — and does NOT query the `_linchkit.*`
 * tables directly.
 *
 * Issue: #137, #138
 * Spec: 14 (System Capabilities), 11 (Execution Log), 66 (Event Bus)
 */

import { defineCapability } from "@linchkit/core";

export const capAuditUi = defineCapability({
  name: "cap-audit-ui",
  label: "Audit Log Viewer UI",
  description:
    "Admin UI for browsing the execution log + the event timeline — list, filter, inspect, and replay.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "audit",
  dependencies: ["cap-adapter-ui"],
  autoInstall: true,
});
