/**
 * Trigger Binding
 *
 * Connects flow triggers to the event system. When an event fires that matches
 * a flow's EventFlowTrigger, the flow is automatically started.
 *
 * - EventFlowTrigger: subscribes to the event bus
 * - ScheduleFlowTrigger: placeholder (real cron in M2)
 * - ManualFlowTrigger: no binding needed (started via API)
 */

import type { EventRecord } from "../types/event";
import type { EventFlowTrigger, FlowDefinition, ScheduleFlowTrigger } from "../types/flow";
import type { FlowEngine } from "./types";

// ── EventBusLike interface (avoids circular deps) ───────────

export interface EventBusLike {
  subscribe(eventType: string, handler: (event: EventRecord) => Promise<void>): () => void;
}

// ── TriggerBinding interface ────────────────────────────────

export interface TriggerBinding {
  /** Bind all registered flows' triggers */
  bindAll(flows: FlowDefinition[], engine: FlowEngine): void;

  /** Unbind all triggers (for shutdown) */
  unbindAll(): void;
}

// ── Filter matching ─────────────────────────────────────────

/**
 * Simple key-value match: every key in the filter must match
 * the corresponding value in the payload.
 */
function matchesFilter(payload: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (payload[key] !== value) {
      return false;
    }
  }
  return true;
}

// ── Implementation ──────────────────────────────────────────

class TriggerBindingImpl implements TriggerBinding {
  private eventBus: EventBusLike;
  private unsubscribers: Array<() => void> = [];
  private scheduledCrons: Array<{ flowName: string; cron: string }> = [];

  constructor(eventBus: EventBusLike) {
    this.eventBus = eventBus;
  }

  bindAll(flows: FlowDefinition[], engine: FlowEngine): void {
    for (const flow of flows) {
      this.bindFlow(flow, engine);
    }
  }

  unbindAll(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.scheduledCrons = [];
  }

  private bindFlow(flow: FlowDefinition, engine: FlowEngine): void {
    const trigger = flow.trigger;

    switch (trigger.type) {
      case "event":
        this.bindEventTrigger(flow.name, trigger, engine);
        break;

      case "schedule":
        this.bindScheduleTrigger(flow.name, trigger);
        break;

      case "manual":
        // Manual triggers are started via API — no binding needed
        break;
    }
  }

  private bindEventTrigger(flowName: string, trigger: EventFlowTrigger, engine: FlowEngine): void {
    const unsub = this.eventBus.subscribe(trigger.eventType, async (event: EventRecord) => {
      // Check filter conditions if present
      if (trigger.filter && !matchesFilter(event.payload, trigger.filter)) {
        return;
      }

      // Generate a deterministic instance ID from flow name + event ID
      const instanceId = `${flowName}-${event.id}`;

      await engine.startFlow(flowName, event.payload, {
        instanceId,
        tenantId: event.tenantId,
        actor: event.actor,
      });
    });

    this.unsubscribers.push(unsub);
  }

  private bindScheduleTrigger(flowName: string, trigger: ScheduleFlowTrigger): void {
    console.warn(
      `[TriggerBinding] Schedule triggers not yet implemented (M2). ` +
        `Flow "${flowName}" cron "${trigger.cron}" will not auto-start.`,
    );
    this.scheduledCrons.push({ flowName, cron: trigger.cron });
  }
}

// ── Factory ─────────────────────────────────────────────────

/** Create a new TriggerBinding connected to the given event bus */
export function createTriggerBinding(eventBus: EventBusLike): TriggerBinding {
  return new TriggerBindingImpl(eventBus);
}
