/**
 * Capability definition for cap-view-timeline.
 *
 * Provides a Gantt/timeline board view component (TimelineBoard) that renders
 * entity records as horizontal bars on a configurable time axis. Supports
 * day / week / month granularity and optional row grouping.
 *
 * This capability complements cap-view-kanban and cap-view-calendar by
 * covering the timeline/Gantt use-case — project tasks, event schedules,
 * resource allocation — without requiring @dnd-kit or a state machine.
 *
 * Spec 54 — Advanced UI Features (timeline view)
 * Issue: #86
 */

import { defineCapability } from "@linchkit/core";

export const capViewTimeline = defineCapability({
  name: "cap-view-timeline",
  label: "Timeline View",
  description:
    "Gantt-style timeline view that renders entity records as horizontal bars on a configurable time axis (day / week / month).",
  type: "standard",
  category: "view",
  version: "0.1.0",
  group: "view-timeline",
  dependencies: ["cap-adapter-ui"],
  autoInstall: false,
});
