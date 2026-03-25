/**
 * Restate-backed Flow Engine
 *
 * Implements FlowEngine by delegating to Restate's ingress API for
 * durable workflow execution. Compiled flows are registered as Restate
 * workflow services — this engine starts/signals/cancels them via HTTP.
 *
 * Unlike SyncFlowEngine, this supports:
 * - Durable execution (survives process crashes)
 * - Approval/wait steps (via DurablePromises and awakeables)
 * - True parallel step execution
 * - Saga compensation on error
 */

import type { FlowDefinition, FlowInstance, FlowInstanceStatus } from "../types/flow";
import type { FlowEngine, RestateConfig } from "./types";

// ── Defaults ────────────────────────────────────────────

const DEFAULT_INGRESS_URL = "http://localhost:8080";

// ── RestateFlowEngine ───────────────────────────────────

/**
 * Create a Restate-backed flow engine.
 *
 * Flows must be compiled and bound to a Restate endpoint separately
 * (via setupRestateEndpoint). This engine only handles the client side:
 * starting flows, querying status, sending signals, and cancelling.
 */
export function createRestateFlowEngine(config: RestateConfig = {}): FlowEngine {
  const ingressUrl = config.adminUrl
    ? config.adminUrl.replace(":9070", ":8080")
    : DEFAULT_INGRESS_URL;

  /** In-memory registry of flow definitions (for name validation only) */
  const flowDefs = new Map<string, FlowDefinition>();

  return {
    registerFlow(definition: FlowDefinition): void {
      flowDefs.set(definition.name, definition);
    },

    async startFlow(flowName, input, options) {
      const definition = flowDefs.get(flowName);
      if (!definition) {
        throw new Error(`Flow "${flowName}" is not registered`);
      }

      const instanceId = options?.instanceId ?? crypto.randomUUID();

      // Call Restate ingress to start the workflow
      // Restate workflow pattern: POST /{serviceName}/{key}/run
      const url = `${ingressUrl}/${flowName}/${instanceId}/run/send`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Failed to start flow "${flowName}" via Restate (${response.status}): ${body}`,
        );
      }

      // Return a FlowInstance representing the started flow
      return {
        id: instanceId,
        flowName,
        status: "running" as FlowInstanceStatus,
        currentStepId: definition.steps[0]?.id ?? "",
        context: { input },
        startedAt: new Date(),
      };
    },

    async getFlowStatus(instanceId) {
      // Query all registered flows to find which one this instance belongs to
      // Restate workflow pattern: GET /{serviceName}/{key}/status
      for (const [flowName] of flowDefs) {
        try {
          const url = `${ingressUrl}/${flowName}/${instanceId}/status`;
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "null",
          });

          if (response.ok) {
            const status = (await response.json()) as string;
            const instance: FlowInstance = {
              id: instanceId,
              flowName,
              status: mapRestateStatus(status),
              currentStepId: "",
              context: {},
              startedAt: new Date(),
            };
            return instance;
          }
        } catch {
          // Try next flow
          continue;
        }
      }

      return null;
    },

    async sendSignal(instanceId, signalName, data) {
      // Signals are sent to workflow shared handlers
      // For approval: POST /{serviceName}/{key}/approve_{stepId}
      // For generic signals: POST /{serviceName}/{key}/signal
      for (const [flowName] of flowDefs) {
        try {
          const url = `${ingressUrl}/${flowName}/${instanceId}/${signalName}`;
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });

          if (response.ok) {
            return;
          }
        } catch {
          continue;
        }
      }

      throw new Error(
        `Failed to send signal "${signalName}" to flow instance "${instanceId}": ` +
          "no matching flow found or Restate is unreachable",
      );
    },

    async cancelFlow(instanceId) {
      // Restate cancel: DELETE /restate/invocations/{invocationId}
      // For workflow key-based cancel, we need to purge
      for (const [flowName] of flowDefs) {
        try {
          const url = `${ingressUrl}/restate/workflow/${flowName}/${instanceId}/cancel`;
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
          });

          if (response.ok) {
            return;
          }
        } catch {
          continue;
        }
      }

      // Best-effort: if we can't cancel via Restate, log a warning
      console.warn(
        `[RestateFlowEngine] Could not cancel flow instance "${instanceId}" — ` +
          "Restate may be unreachable or the instance may have already completed",
      );
    },
  };
}

// ── Helpers ─────────────────────────────────────────────

function mapRestateStatus(restateStatus: string): FlowInstanceStatus {
  switch (restateStatus) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      // Statuses like "waiting_approval:xxx" or "waiting_signal:xxx" map to paused
      if (restateStatus.startsWith("waiting")) {
        return "paused";
      }
      return "running";
  }
}
