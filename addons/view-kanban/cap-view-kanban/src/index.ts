/**
 * Public entry point for @linchkit/cap-view-kanban.
 *
 * Exports the React components, hook, helpers, and capability metadata.
 * The `./i18n` import is side-effect-only — it adds the capability's
 * `en` / `zh-CN` bundles to the shared react-i18next instance owned by
 * cap-adapter-ui so every `t("kanban.…")` key resolves on first render.
 * Keep it ABOVE the value re-exports so the labels in capability metadata
 * (and any default-rendered text) resolve correctly. No panel / route is
 * registered here today — that arrives once the runtime view-type
 * registry lands.
 */

import "./i18n";

export { capViewKanban } from "./capability";
export { registerKanbanI18nResources } from "./i18n";
export { KanbanBoard } from "./KanbanBoard";
export { KanbanCard } from "./KanbanCard";
export { KanbanColumn } from "./KanbanColumn";
export type {
  DropValidation,
  KanbanBoardProps,
  KanbanCardProps,
  KanbanColumnProps,
  KanbanRecord,
  TransitionFn,
} from "./types";
export {
  defaultTransition,
  groupRecordsByState,
  indexTransitions,
  orderColumns,
  useKanbanData,
  validateDrop,
} from "./use-kanban-data";
