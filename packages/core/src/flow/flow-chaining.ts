/**
 * Flow Chaining — orchestration of flow-to-flow dependencies
 *
 * Provides:
 * - `flow.completed` / `flow.failed` event emission after flow execution
 * - Circular dependency detection for flow chains
 * - Flow dependency graph analysis (upstream/downstream relationships)
 * - Input mapping from upstream flow output to downstream flow input
 */

import type { EventBusLike, EventRecord } from "../types/event";
import type { FlowDefinition, FlowInstance } from "../types/flow";
import type { FlowEngine, FlowRegistry } from "./types";

// ── Event names ──────────────────────────────────────────

export const FLOW_COMPLETED_EVENT = "flow.completed";
export const FLOW_FAILED_EVENT = "flow.failed";

// ── Flow completion event payload ────────────────────────

export interface FlowCompletedPayload {
  /** Name of the flow that completed */
  flowName: string;
  /** Instance ID */
  instanceId: string;
  /** Completion status */
  status: "completed" | "failed";
  /** Flow result context (accumulated step outputs) */
  result: Record<string, unknown>;
  /** Error details if failed */
  error?: { stepId: string; message: string };
}

// ── Emit flow completion event ───────────────────────────

/**
 * Emit a flow.completed or flow.failed event to the EventBus.
 * Called by flow engines after a flow finishes execution.
 * Returns a promise so the caller can choose to await or fire-and-forget.
 */
export async function emitFlowCompletionEvent(
  eventBus: EventBusLike & { emit?: (event: EventRecord) => Promise<void> },
  instance: FlowInstance,
): Promise<void> {
  const eventType = instance.status === "completed" ? FLOW_COMPLETED_EVENT : FLOW_FAILED_EVENT;

  const payload: FlowCompletedPayload = {
    flowName: instance.flowName,
    instanceId: instance.id,
    status: instance.status as "completed" | "failed",
    result: instance.context,
    error: instance.error,
  };

  const event: EventRecord = {
    id: crypto.randomUUID(),
    type: eventType,
    category: "runtime",
    timestamp: new Date(),
    actor: { type: "system", id: "flow-engine" },
    executionId: instance.id,
    payload: payload as unknown as Record<string, unknown>,
  };

  if (typeof eventBus.emit === "function") {
    try {
      await eventBus.emit(event);
    } catch {
      // Swallow errors from event emission — don't fail the flow
    }
  }
}

// ── Input mapping ────────────────────────────────────────

/**
 * Resolve input mapping expressions against the upstream flow result.
 *
 * Expression format:
 * - `$result.fieldName` — direct field from flow context
 * - `$steps.stepId.output.fieldName` — specific step output
 * - `$flowName` — the upstream flow name
 * - `$instanceId` — the upstream instance ID
 * - literal values (no `$` prefix) — passed through as-is
 */
export function resolveInputMapping(
  mapping: Record<string, string>,
  payload: FlowCompletedPayload,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, expr] of Object.entries(mapping)) {
    if (!expr.startsWith("$")) {
      result[key] = expr;
      continue;
    }

    if (expr === "$flowName") {
      result[key] = payload.flowName;
    } else if (expr === "$instanceId") {
      result[key] = payload.instanceId;
    } else if (expr === "$status") {
      result[key] = payload.status;
    } else if (expr.startsWith("$result.")) {
      const path = expr.slice("$result.".length);
      result[key] = getNestedValue(payload.result, path);
    } else if (expr.startsWith("$error.")) {
      const path = expr.slice("$error.".length);
      result[key] = payload.error
        ? getNestedValue(payload.error as unknown as Record<string, unknown>, path)
        : undefined;
    } else {
      // Unknown expression — pass through
      result[key] = expr;
    }
  }

  return result;
}

/** Resolve a dot-separated path against a nested object */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// ── Circular dependency detection ────────────────────────

/**
 * Detect circular dependencies in flow chains.
 * Returns the cycle path if found (e.g., ["A", "B", "C", "A"]), or null if no cycle.
 */
export function detectFlowCycle(
  flowRegistry: FlowRegistry,
  startFlowName: string,
  additionalChains?: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const path: string[] = [];

  function _dfs(flowName: string): string[] | null {
    if (visited.has(flowName)) {
      // Found cycle — extract the cycle portion
      const cycleStart = path.indexOf(flowName);
      if (cycleStart !== -1) {
        return [...path.slice(cycleStart), flowName];
      }
      return null;
    }

    visited.add(flowName);
    path.push(flowName);

    const downstream = getDownstreamFlows(flowRegistry, flowName, additionalChains);
    for (const next of downstream) {
      // Need to track recursion stack separately from visited
      const result = _dfs(next);
      if (result) return result;
    }

    path.pop();
    // Don't remove from visited — we've fully explored this node
    // Actually, for cycle detection in directed graphs we need to distinguish
    // "in current path" vs "fully explored"
    return null;
  }

  // Use proper DFS with "in-stack" tracking
  return dfsWithStack(flowRegistry, startFlowName, additionalChains);
}

/**
 * DFS cycle detection with proper "in recursion stack" tracking.
 */
function dfsWithStack(
  flowRegistry: FlowRegistry,
  startFlowName: string,
  additionalChains?: Map<string, string[]>,
): string[] | null {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(flowName: string): string[] | null {
    if (inStack.has(flowName)) {
      const cycleStart = path.indexOf(flowName);
      return [...path.slice(cycleStart), flowName];
    }

    if (visited.has(flowName)) return null;

    visited.add(flowName);
    inStack.add(flowName);
    path.push(flowName);

    const downstream = getDownstreamFlows(flowRegistry, flowName, additionalChains);
    for (const next of downstream) {
      const result = dfs(next);
      if (result) return result;
    }

    path.pop();
    inStack.delete(flowName);
    return null;
  }

  return dfs(startFlowName);
}

// ── Flow dependency graph ────────────────────────────────

export interface FlowDependencyInfo {
  /** Flows that trigger this flow (upstream) */
  upstream: string[];
  /** Flows triggered by this flow (downstream) */
  downstream: string[];
}

/**
 * Get all downstream flows triggered by a given flow.
 * Considers both explicit `onComplete` chains and event-based triggers.
 */
function getDownstreamFlows(
  flowRegistry: FlowRegistry,
  flowName: string,
  additionalChains?: Map<string, string[]>,
): string[] {
  const downstream: string[] = [];

  // Check explicit onComplete chains
  const flow = flowRegistry.get(flowName);
  if (flow?.onComplete) {
    const chains = Array.isArray(flow.onComplete) ? flow.onComplete : [flow.onComplete];
    for (const chain of chains) {
      downstream.push(chain.flow);
    }
  }

  // Check additional chains (e.g., from automation triggers)
  if (additionalChains?.has(flowName)) {
    downstream.push(...(additionalChains.get(flowName) ?? []));
  }

  return downstream;
}

/**
 * Build the full dependency graph for a flow.
 *
 * @param flowRegistry - Registry containing all flow definitions
 * @param flowName - The flow to analyze
 * @param automationChains - Map of flow name → downstream flows from automation triggers
 * @returns Upstream and downstream flow names
 */
export function getFlowDependencies(
  flowRegistry: FlowRegistry,
  flowName: string,
  automationChains?: Map<string, string[]>,
): FlowDependencyInfo {
  const downstream = getDownstreamFlows(flowRegistry, flowName, automationChains);

  // Find upstream: scan all flows for onComplete pointing to this flow
  const upstream: string[] = [];
  for (const flow of flowRegistry.getAll()) {
    if (!flow.onComplete) continue;
    const chains = Array.isArray(flow.onComplete) ? flow.onComplete : [flow.onComplete];
    for (const chain of chains) {
      if (chain.flow === flowName) {
        upstream.push(flow.name);
      }
    }
  }

  // Also check automation chains for upstream
  if (automationChains) {
    for (const [source, targets] of automationChains.entries()) {
      if (targets.includes(flowName) && !upstream.includes(source)) {
        upstream.push(source);
      }
    }
  }

  return { upstream, downstream };
}

// ── Process explicit onComplete chains ───────────────────

/**
 * Execute explicit onComplete chains after a flow finishes.
 * Called by the flow engine after successful completion.
 */
export async function processOnCompleteChains(
  instance: FlowInstance,
  flowRegistry: FlowRegistry,
  flowEngine: FlowEngine,
): Promise<void> {
  const definition = flowRegistry.get(instance.flowName);
  if (!definition?.onComplete) return;

  const chains = Array.isArray(definition.onComplete)
    ? definition.onComplete
    : [definition.onComplete];

  const statusFilter = instance.status as "completed" | "failed";

  for (const chain of chains) {
    // Check status filter (default: only on "completed")
    const requiredStatus = chain.onStatus ?? "completed";
    if (statusFilter !== requiredStatus) continue;

    // Build input from mapping
    const payload: FlowCompletedPayload = {
      flowName: instance.flowName,
      instanceId: instance.id,
      status: statusFilter,
      result: instance.context,
      error: instance.error,
    };

    const input = chain.inputMapping
      ? resolveInputMapping(chain.inputMapping, payload)
      : { _upstream: payload };

    // Inherit the parent flow's tenant scope and actor so the downstream flow
    // runs within the originating tenant boundary instead of with no tenant
    // scope and the default/system actor (tenant-isolation correctness).
    await flowEngine.startFlow(chain.flow, input, {
      tenantId: instance.tenantId,
      actor: instance.actor,
    });
  }
}

// ── Validate flow chains on registration ─────────────────

/**
 * Validate that registering a flow with onComplete chains doesn't create cycles.
 * Throws if a cycle would be introduced.
 */
export function validateFlowChains(
  flow: FlowDefinition,
  flowRegistry: FlowRegistry,
  additionalChains?: Map<string, string[]>,
): void {
  if (!flow.onComplete) return;

  // Temporarily add this flow to detect cycles
  const chains = Array.isArray(flow.onComplete) ? flow.onComplete : [flow.onComplete];
  const tempChains = new Map(additionalChains ?? []);

  // Add the new flow's chains
  const existing = tempChains.get(flow.name) ?? [];
  tempChains.set(flow.name, [...existing, ...chains.map((c) => c.flow)]);

  const cycle = detectFlowCycle(flowRegistry, flow.name, tempChains);
  if (cycle) {
    throw new Error(
      `Flow chain cycle detected: ${cycle.join(" -> ")}. ` +
        `Cannot register flow "${flow.name}" with onComplete targeting "${chains.map((c) => c.flow).join(", ")}".`,
    );
  }
}
