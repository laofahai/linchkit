/**
 * Public type surface for cap-view-kanban.
 *
 * Kept separate from the components so consumers can declare props types
 * without pulling in React or @dnd-kit at type-only sites.
 */

import type { EntityDefinition, StateDefinition } from "@linchkit/core/types";

/** A record displayed as a card. `id` is required; other fields are arbitrary. */
export interface KanbanRecord extends Record<string, unknown> {
  id: string;
}

/**
 * Strategy for performing a state transition. The default implementation
 * uses the GraphQL `transition<Entity>` mutation via cap-adapter-ui;
 * tests inject a stub so no network is hit.
 */
export type TransitionFn = (input: {
  entity: string;
  recordId: string;
  to: string;
  fields: string[];
}) => Promise<KanbanRecord>;

/** Props for the top-level KanbanBoard component. */
export interface KanbanBoardProps {
  /** Entity name (snake_case), e.g. "purchase_request". */
  entity: string;
  /** Resolved entity definition — supplies field metadata / presentation hints. */
  schema: EntityDefinition;
  /** State machine for the entity. Columns derive from `states` + `transitions`. */
  stateDefinition: StateDefinition;
  /**
   * Field name on each record that carries the state value.
   * Defaults to `stateDefinition.field`.
   */
  stateField?: string;
  /** Records to render. Each must include `id` and the state field. */
  data: ReadonlyArray<KanbanRecord>;
  /** Field names to display on each card (in order). Optional — falls back to the title field. */
  cardFields?: ReadonlyArray<string>;
  /** Loading indicator — replaces the board with skeleton columns. */
  loading?: boolean;
  /** Error message to render instead of the board. */
  error?: string | null;
  /** Called when a card is clicked. */
  onCardClick?: (recordId: string) => void;
  /** Called after a successful transition so the parent can refetch. */
  onTransitioned?: (input: { recordId: string; from: string; to: string }) => void;
  /** Called when a transition fails (validation OR network). */
  onTransitionError?: (input: { recordId: string; to: string; error: Error }) => void;
  /** GraphQL fields to request back after the transition mutation. Default: `["id", stateField]`. */
  queryFields?: ReadonlyArray<string>;
  /** Injection point for tests / custom transports. Defaults to the cap-adapter-ui GraphQL helper. */
  transition?: TransitionFn;
  /** Optional className applied to the board wrapper. */
  className?: string;
}

/** Props for KanbanColumn. */
export interface KanbanColumnProps {
  stateValue: string;
  label: string;
  records: ReadonlyArray<KanbanRecord>;
  schema: EntityDefinition;
  cardFields: ReadonlyArray<string>;
  /** When dragging, target columns that are not valid transition destinations get a "deny" visual. */
  isInvalidTarget: boolean;
  onCardClick?: (recordId: string) => void;
  pendingRecordId: string | null;
}

/** Props for KanbanCard. */
export interface KanbanCardProps {
  record: KanbanRecord;
  schema: EntityDefinition;
  cardFields: ReadonlyArray<string>;
  onClick?: (recordId: string) => void;
  isPending: boolean;
}

/** Result of validating a drop attempt before issuing the transition mutation. */
export interface DropValidation {
  allowed: boolean;
  reason?: "same-column" | "no-transition" | "missing-state";
}
