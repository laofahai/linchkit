/**
 * State Machine Engine
 *
 * Pure TypeScript implementation for managing lifecycle state transitions.
 * Transitions are bound to actions; direct state modification is not allowed.
 */

import type { StateDefinition, Transition, TransitionResult } from "../types/state";

// ── State Machine instance ──────────────────────────────

export interface StateMachine<TStates extends string = string> {
  /** The underlying definition */
  readonly definition: StateDefinition<TStates>;

  /** Index: action -> transitions that respond to that action */
  readonly transitionsByAction: ReadonlyMap<string, Transition[]>;

  /** Index: state -> transitions originating from that state */
  readonly transitionsBySource: ReadonlyMap<string, Transition[]>;
}

// ── Factory ─────────────────────────────────────────────

/**
 * Creates a state machine instance from a definition.
 * Validates the definition and builds internal indexes for fast lookups.
 */
export function createStateMachine<TStates extends string>(
  definition: StateDefinition<TStates>,
): StateMachine<TStates> {
  // Validate definition
  validateDefinition(definition);

  // Build indexes
  const transitionsByAction = new Map<string, Transition[]>();
  const transitionsBySource = new Map<string, Transition[]>();

  for (const t of definition.transitions) {
    // Index by action
    const byAction = transitionsByAction.get(t.action);
    if (byAction) {
      byAction.push(t);
    } else {
      transitionsByAction.set(t.action, [t]);
    }

    // Index by source state(s)
    const sources = Array.isArray(t.from) ? t.from : [t.from];
    for (const src of sources) {
      const bySource = transitionsBySource.get(src);
      if (bySource) {
        bySource.push(t);
      } else {
        transitionsBySource.set(src, [t]);
      }
    }
  }

  return {
    definition,
    transitionsByAction,
    transitionsBySource,
  };
}

// ── Transition execution ────────────────────────────────

/**
 * Attempts a state transition. Returns a TransitionResult indicating
 * whether the transition was allowed and the resulting state.
 */
export function transition(
  machine: StateMachine,
  currentState: string,
  action: string,
): TransitionResult {
  // Verify current state is valid
  if (!machine.definition.states.includes(currentState)) {
    return {
      allowed: false,
      from: currentState,
      action,
      reason: `Invalid current state: "${currentState}"`,
      context: {
        entity: machine.definition.entity,
        action,
        field: machine.definition.field,
        constraint: "state_machine",
        expected: `One of [${machine.definition.states.join(", ")}]`,
        actual: currentState,
        suggestion: `State "${currentState}" is not defined in state machine "${machine.definition.name}". Valid states: [${machine.definition.states.join(", ")}]`,
      },
    };
  }

  // Find a matching transition
  const match = findTransition(machine, currentState, action);

  if (!match) {
    const available = getAvailableActions(machine, currentState);
    return {
      allowed: false,
      from: currentState,
      action,
      reason: `No transition for action "${action}" from state "${currentState}"`,
      context: {
        entity: machine.definition.entity,
        action,
        field: machine.definition.field,
        constraint: "state_transition",
        expected: `Action "${action}" allowed from state "${currentState}"`,
        actual: `No transition defined for "${action}" from "${currentState}"`,
        suggestion:
          available.length > 0
            ? `Available actions from "${currentState}": [${available.join(", ")}]`
            : `No actions available from state "${currentState}" — this may be a terminal state`,
      },
    };
  }

  return {
    allowed: true,
    from: currentState,
    to: match.to,
    action,
  };
}

// ── Query helpers ───────────────────────────────────────

/**
 * Checks whether a transition is possible from the current state with
 * the given action, without executing it.
 */
export function canTransition(
  machine: StateMachine,
  currentState: string,
  action: string,
): boolean {
  if (!machine.definition.states.includes(currentState)) {
    return false;
  }
  return findTransition(machine, currentState, action) !== undefined;
}

/**
 * Returns all actions that are valid from the given state.
 */
export function getAvailableActions(machine: StateMachine, currentState: string): string[] {
  const transitions = machine.transitionsBySource.get(currentState);
  if (!transitions) {
    return [];
  }

  // Deduplicate action names
  const seen = new Set<string>();
  const actions: string[] = [];
  for (const t of transitions) {
    if (!seen.has(t.action)) {
      seen.add(t.action);
      actions.push(t.action);
    }
  }
  return actions;
}

/**
 * Returns all valid transitions from the given state, including target state and action.
 */
export function getAvailableTransitions(
  machine: StateMachine,
  currentState: string,
): Array<{ from: string; to: string; action: string }> {
  const transitions = machine.transitionsBySource.get(currentState);
  if (!transitions) {
    return [];
  }
  return transitions.map((t) => ({ from: currentState, to: t.to, action: t.action }));
}

// ── Internal helpers ────────────────────────────────────

/**
 * Finds a transition matching the given current state and action.
 */
function findTransition(
  machine: StateMachine,
  currentState: string,
  action: string,
): Transition | undefined {
  const candidates = machine.transitionsByAction.get(action);
  if (!candidates) {
    return undefined;
  }

  for (const t of candidates) {
    const sources = Array.isArray(t.from) ? t.from : [t.from];
    if (sources.includes(currentState)) {
      return t;
    }
  }

  return undefined;
}

/**
 * Validates a state definition, throwing on structural errors.
 */
function validateDefinition(definition: StateDefinition): void {
  if (!definition.name) {
    throw new Error("State definition must have a name");
  }

  if (!definition.states || definition.states.length === 0) {
    throw new Error(`State definition "${definition.name}" must have at least one state`);
  }

  if (!definition.initial) {
    throw new Error(`State definition "${definition.name}" must have an initial state`);
  }

  if (!definition.states.includes(definition.initial)) {
    throw new Error(
      `Initial state "${definition.initial}" is not in the states list of "${definition.name}"`,
    );
  }

  // Validate transitions reference valid states
  for (const t of definition.transitions) {
    const sources = Array.isArray(t.from) ? t.from : [t.from];
    for (const src of sources) {
      if (!definition.states.includes(src)) {
        throw new Error(
          `Transition action "${t.action}" references unknown source state "${src}" in "${definition.name}"`,
        );
      }
    }
    if (!definition.states.includes(t.to)) {
      throw new Error(
        `Transition action "${t.action}" references unknown target state "${t.to}" in "${definition.name}"`,
      );
    }
  }
}
