/**
 * Public entry point for @linchkit/cap-view-kanban.
 *
 * Exports the React components, hook, helpers, and capability metadata.
 * No side effects at import time — host apps decide when to mount the
 * board (no panel / route registration today; that arrives once the
 * runtime view-type registry lands).
 */

export { capViewKanban } from "./capability";
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
