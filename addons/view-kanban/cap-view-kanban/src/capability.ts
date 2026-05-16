/**
 * Capability definition for cap-view-kanban.
 *
 * Provides a Kanban board view component (KanbanBoard) that renders entity
 * records grouped by a state field, with drag-and-drop column moves wired
 * to the entity's transition action. Columns are derived from the entity's
 * `defineState()` state machine; drops outside the declared transitions are
 * rejected client-side before the mutation fires.
 *
 * This is a standalone alternative to the in-tree AutoKanban inside
 * cap-adapter-ui — it uses @dnd-kit (accessible, pointer + keyboard +
 * touch) instead of the native HTML5 drag API, and it ships with a
 * smaller surface that can be consumed directly by a host app or wrapped
 * by a future view-type registry.
 *
 * Spec 54 — Advanced UI Features (kanban view)
 * Issue: #86
 */

import { defineCapability } from "@linchkit/core";

export const capViewKanban = defineCapability({
  name: "cap-view-kanban",
  label: "Kanban View",
  description:
    "Kanban board view with accessible drag-and-drop column moves wired to entity state transitions.",
  type: "standard",
  category: "view",
  version: "0.1.0",
  group: "view-kanban",
  dependencies: ["cap-adapter-ui"],
  autoInstall: false,
});
