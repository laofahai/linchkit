/**
 * Internal Flow Engine types
 *
 * These types define the runtime interfaces for the Flow Engine.
 * Public types (FlowDefinition, FlowStep, etc.) are in types/flow.ts.
 *
 * Restate-specific types (CompiledFlow, FlowCompiler, RestateConfig,
 * FlowEngineConfig) have been moved to @linchkit/cap-flow-restate.
 */

import type { Actor } from "../types/action";
import type { FlowDefinition, FlowInstance } from "../types/flow";

// ── Flow Engine interface ───────────────────────────────

/** Main Flow Engine — manages flow lifecycle */
export interface FlowEngine {
  /** Register a flow definition with the engine */
  registerFlow(definition: FlowDefinition): void;

  /** Start a new flow instance */
  startFlow(
    flowName: string,
    input: Record<string, unknown>,
    options?: {
      instanceId?: string;
      tenantId?: string;
      actor?: Actor;
    },
  ): Promise<FlowInstance>;

  /** Get status of a flow instance */
  getFlowStatus(instanceId: string): Promise<FlowInstance | null>;

  /** Send a signal to a running flow instance (e.g., approval) */
  sendSignal(instanceId: string, signalName: string, data: unknown): Promise<void>;

  /** Cancel a running flow instance */
  cancelFlow(instanceId: string): Promise<void>;
}

// ── Flow Runtime Context ────────────────────────────────

/** Context available to flow steps during execution */
export interface FlowStepContext {
  /** Execute a LinchKit action */
  executeAction(
    actionName: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Call AI service */
  callAI(options: {
    prompt: string;
    model?: string;
    tools?: string[];
    responseFormat?: { type: "json"; schema: string };
  }): Promise<{
    response: string;
    tokensUsed: number;
    toolCalls?: Array<{ toolName: string; args: Record<string, unknown> }>;
  }>;

  /** Evaluate a condition expression */
  evaluateCondition(expression: string, context: Record<string, unknown>): boolean;

  /** Flow instance data accumulated from previous steps */
  flowContext: Record<string, unknown>;

  /** Tenant ID (if multi-tenant) */
  tenantId?: string;

  /** Actor who triggered the flow */
  actor?: Actor;
}

// ── Flow Registry ───────────────────────────────────────

/** Registry that stores and retrieves FlowDefinitions */
export interface FlowRegistry {
  /** Register a flow definition */
  register(flow: FlowDefinition): void;

  /** Get a flow definition by name */
  get(name: string): FlowDefinition | undefined;

  /** Get all registered flow definitions */
  getAll(): FlowDefinition[];

  /** Check if a flow exists */
  has(name: string): boolean;
}
