/**
 * Restate-specific Flow Engine types
 *
 * These types define the Restate runtime interfaces.
 * Generic flow types (FlowEngine, FlowStepContext, FlowRegistry) remain in @linchkit/core.
 */

import type { FlowDefinition } from "@linchkit/core";
import type { FlowStepContext } from "@linchkit/core/server";

// ── Flow Compiler ───────────────────────────────────────

/** Result of compiling a FlowDefinition into a Restate workflow */
export interface CompiledFlow {
  /** The flow definition this was compiled from */
  definition: FlowDefinition;

  /** Restate workflow service object (to bind to endpoint) */
  restateService: unknown; // restate.workflow() result — typed as unknown to avoid leaking Restate types

  /** Signal handler names generated for this flow */
  signalHandlers: string[];
}

/** Compiles FlowDefinition into Restate workflow handlers */
export interface FlowCompiler {
  compile(definition: FlowDefinition, stepContext: FlowStepContext): CompiledFlow;
}

// ── Restate Connection Config ───────────────────────────

export interface RestateConfig {
  /** Restate admin URL (default: http://localhost:9070) */
  adminUrl?: string;

  /** Restate ingress URL (default: http://localhost:8080). If omitted, derived from adminUrl. */
  ingressUrl?: string;

  /** Port for the workflow service endpoint (default: 9080) */
  servicePort?: number;

  /** Whether to auto-register deployments with Restate on startup (default: true in dev) */
  autoRegister?: boolean;
}

// ── Dual-mode Flow Engine Config ────────────────────────

export interface FlowEngineConfig {
  /** Restate config — if provided, uses Restate for durable execution */
  restate?: RestateConfig;

  /** Fallback: simple sync execution when no Restate server available */
  // When restate is undefined, flows run synchronously (no durability, no approval/wait support)
}
