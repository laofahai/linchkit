/**
 * testStateMachine — Unit test utility for State Machine definitions
 *
 * Checks whether a given state transition is allowed by the state machine definition.
 */

import type { StateDefinition, TransitionResult } from "@linchkit/core";

export interface TestTransitionInput {
  from: string;
  to: string;
  action?: string;
}

/**
 * Test whether a state transition is valid according to the state machine definition.
 */
export function testStateMachine(
  definition: StateDefinition,
  input: TestTransitionInput,
): TransitionResult {
  // Check if both states exist
  if (!definition.states.includes(input.from)) {
    return {
      allowed: false,
      from: input.from,
      reason: `State "${input.from}" does not exist in state machine "${definition.name}"`,
    };
  }

  if (!definition.states.includes(input.to)) {
    return {
      allowed: false,
      from: input.from,
      to: input.to,
      reason: `State "${input.to}" does not exist in state machine "${definition.name}"`,
    };
  }

  // Find matching transition
  const transition = definition.transitions.find((t) => {
    const fromMatch = Array.isArray(t.from) ? t.from.includes(input.from) : t.from === input.from;
    const toMatch = t.to === input.to;
    const actionMatch = input.action ? t.action === input.action : true;
    return fromMatch && toMatch && actionMatch;
  });

  if (!transition) {
    return {
      allowed: false,
      from: input.from,
      to: input.to,
      reason: `No transition from "${input.from}" to "${input.to}" in state machine "${definition.name}"`,
    };
  }

  return {
    allowed: true,
    from: input.from,
    to: input.to,
    action: transition.action,
  };
}

/**
 * Get all valid transitions from a given state.
 */
export function getAvailableTransitions(
  definition: StateDefinition,
  currentState: string,
): Array<{ to: string; action: string }> {
  return definition.transitions
    .filter((t) => {
      return Array.isArray(t.from) ? t.from.includes(currentState) : t.from === currentState;
    })
    .map((t) => ({ to: t.to, action: t.action }));
}
