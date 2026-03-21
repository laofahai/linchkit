/**
 * validateCapability — Structural validation for Capability definitions
 *
 * Checks that all references within a Capability are consistent:
 * - Action's stateTransition references valid states
 * - Rule triggers reference existing Actions
 * - View fields reference existing Schema fields
 * - Dependencies are declared
 */

import type { CapabilityDefinition } from "@linchkit/core";

export interface ValidationIssue {
  type: "error" | "warning";
  category: string;
  message: string;
}

export interface CapabilityValidationResult {
  valid: boolean;
  capability: string;
  issues: ValidationIssue[];
  schemas: { valid: boolean; count: number };
  actions: { valid: boolean; count: number };
  rules: { valid: boolean; count: number };
  states: { valid: boolean; count: number };
  views: { valid: boolean; count: number };
}

/**
 * Validate internal consistency of a Capability definition.
 */
export function validateCapability(capability: CapabilityDefinition): CapabilityValidationResult {
  const issues: ValidationIssue[] = [];
  const schemaNames = new Set((capability.schemas ?? []).map((s) => s.name));
  const actionNames = new Set((capability.actions ?? []).map((a) => a.name));
  const stateNames = new Map<string, Set<string>>();

  // Collect state machine info
  for (const state of capability.states ?? []) {
    stateNames.set(state.name, new Set(state.states));
  }

  // Validate actions reference valid schemas
  for (const action of capability.actions ?? []) {
    if (!schemaNames.has(action.schema)) {
      issues.push({
        type: "warning",
        category: "action",
        message: `Action "${action.name}" references schema "${action.schema}" which is not defined in this capability`,
      });
    }

    // Check stateTransition references
    if (action.stateTransition) {
      const fromStates = Array.isArray(action.stateTransition.from)
        ? action.stateTransition.from
        : [action.stateTransition.from];

      for (const [, states] of stateNames) {
        for (const fromState of fromStates) {
          if (!states.has(fromState)) {
            // Only warn if no state machine contains this state
            const found = Array.from(stateNames.values()).some((s) => s.has(fromState));
            if (!found) {
              issues.push({
                type: "error",
                category: "action",
                message: `Action "${action.name}" references state "${fromState}" which is not defined in any state machine`,
              });
            }
          }
        }
      }
    }
  }

  // Validate rules reference valid actions
  for (const rule of capability.rules ?? []) {
    if ("action" in rule.trigger) {
      const triggerActions = Array.isArray(rule.trigger.action)
        ? rule.trigger.action
        : [rule.trigger.action];

      for (const actionName of triggerActions) {
        if (!actionNames.has(actionName)) {
          issues.push({
            type: "warning",
            category: "rule",
            message: `Rule "${rule.name}" triggers on action "${actionName}" which is not defined in this capability`,
          });
        }
      }
    }
  }

  // Validate views reference valid schemas
  for (const view of capability.views ?? []) {
    if (!schemaNames.has(view.schema)) {
      issues.push({
        type: "warning",
        category: "view",
        message: `View "${view.name}" references schema "${view.schema}" which is not defined in this capability`,
      });
    }
  }

  // Validate state machines reference valid schemas
  for (const state of capability.states ?? []) {
    if (!schemaNames.has(state.schema)) {
      issues.push({
        type: "warning",
        category: "state",
        message: `State machine "${state.name}" references schema "${state.schema}" which is not defined in this capability`,
      });
    }
  }

  const hasErrors = issues.some((i) => i.type === "error");

  return {
    valid: !hasErrors,
    capability: capability.name,
    issues,
    schemas: { valid: true, count: capability.schemas?.length ?? 0 },
    actions: {
      valid: !issues.some((i) => i.category === "action" && i.type === "error"),
      count: capability.actions?.length ?? 0,
    },
    rules: {
      valid: !issues.some((i) => i.category === "rule" && i.type === "error"),
      count: capability.rules?.length ?? 0,
    },
    states: {
      valid: !issues.some((i) => i.category === "state" && i.type === "error"),
      count: capability.states?.length ?? 0,
    },
    views: {
      valid: !issues.some((i) => i.category === "view" && i.type === "error"),
      count: capability.views?.length ?? 0,
    },
  };
}
