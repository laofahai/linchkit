/**
 * Flow Registry
 *
 * Stores and retrieves FlowDefinitions. Validates flow structure on registration.
 * Follows the same pattern as SchemaRegistry.
 */

import type {
  ConditionFlowStep,
  FlowDefinition,
  FlowStep,
  ParallelFlowStep,
} from "../types/flow";
import type { FlowRegistry as IFlowRegistry } from "./types";

// ── FlowRegistryImpl ───────────────────────────────────────

export class FlowRegistryImpl implements IFlowRegistry {
  private flows = new Map<string, FlowDefinition>();

  /** Register a flow definition with structural validation. */
  register(flow: FlowDefinition): void {
    validateFlow(flow);

    if (this.flows.has(flow.name)) {
      console.warn(`[FlowRegistry] Flow "${flow.name}" is already registered — overwriting.`);
    }

    this.flows.set(flow.name, flow);
  }

  /** Get a flow definition by name */
  get(name: string): FlowDefinition | undefined {
    return this.flows.get(name);
  }

  /** Get all registered flow definitions */
  getAll(): FlowDefinition[] {
    return Array.from(this.flows.values());
  }

  /** Check if a flow exists */
  has(name: string): boolean {
    return this.flows.has(name);
  }
}

// ── Validation ──────────────────────────────────────────────

function validateFlow(flow: FlowDefinition): void {
  if (!flow.name || flow.name.trim() === "") {
    throw new Error("Flow must have a non-empty name");
  }

  if (!flow.steps || flow.steps.length === 0) {
    throw new Error(`Flow "${flow.name}" must have at least one step`);
  }

  // Collect all step IDs and check for uniqueness
  const stepIds = new Set<string>();
  for (const step of flow.steps) {
    if (stepIds.has(step.id)) {
      throw new Error(`Flow "${flow.name}" has duplicate step ID "${step.id}"`);
    }
    stepIds.add(step.id);
  }

  // Validate cross-references within steps
  for (const step of flow.steps) {
    validateStepReferences(flow.name, step, stepIds);
  }
}

function validateStepReferences(flowName: string, step: FlowStep, stepIds: Set<string>): void {
  if (step.type === "condition") {
    const cond = step as ConditionFlowStep;
    if (!stepIds.has(cond.then)) {
      throw new Error(
        `Flow "${flowName}" condition step "${step.id}" references unknown step "${cond.then}" in "then"`,
      );
    }
    if (cond.else && !stepIds.has(cond.else)) {
      throw new Error(
        `Flow "${flowName}" condition step "${step.id}" references unknown step "${cond.else}" in "else"`,
      );
    }
  }

  if (step.type === "parallel") {
    const par = step as ParallelFlowStep;
    for (const refId of par.steps) {
      if (!stepIds.has(refId)) {
        throw new Error(
          `Flow "${flowName}" parallel step "${step.id}" references unknown step "${refId}"`,
        );
      }
    }
  }
}

// ── Factory ─────────────────────────────────────────────────

/** Create a new FlowRegistry instance */
export function createFlowRegistry(): FlowRegistryImpl {
  return new FlowRegistryImpl();
}
