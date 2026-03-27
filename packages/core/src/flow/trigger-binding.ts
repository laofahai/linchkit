/**
 * Trigger Binding
 *
 * Connects flow triggers to the event system. When an event fires that matches
 * a flow's EventFlowTrigger, the flow is automatically started.
 *
 * - EventFlowTrigger: subscribes to the event bus
 * - ScheduleFlowTrigger: uses croner for real cron scheduling
 * - ManualFlowTrigger: no binding needed (started via API)
 */

import { Cron } from "croner";
import { consoleLogger } from "../observability/console-logger";
import type { ActorType } from "../types/action";
import type { EventBusLike, EventRecord } from "../types/event";
import type { EventFlowTrigger, FlowDefinition, ScheduleFlowTrigger } from "../types/flow";
import type { Logger } from "../types/logger";
import type { FlowEngine } from "./types";

// Re-export for backwards compatibility
export type { EventBusLike } from "../types/event";

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
  private logger: Logger;
  private unsubscribers: Array<() => void> = [];
  private cronJobs: Cron[] = [];

  constructor(eventBus: EventBusLike, logger: Logger = consoleLogger) {
    this.eventBus = eventBus;
    this.logger = logger;
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

    for (const job of this.cronJobs) {
      job.stop();
    }
    this.cronJobs = [];
  }

  private bindFlow(flow: FlowDefinition, engine: FlowEngine): void {
    const trigger = flow.trigger;

    switch (trigger.type) {
      case "event":
        this.bindEventTrigger(flow.name, trigger, engine);
        break;

      case "schedule":
        this.bindScheduleTrigger(flow.name, trigger, engine);
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

      // Normalize event actor to full Actor shape (EventRecord.actor lacks groups)
      const actor = event.actor
        ? {
            type: event.actor.type as ActorType,
            id: event.actor.id,
            groups: [] as string[],
          }
        : undefined;

      await engine.startFlow(flowName, event.payload, {
        instanceId,
        tenantId: event.tenantId,
        actor,
      });
    });

    this.unsubscribers.push(unsub);
  }

  private bindScheduleTrigger(
    flowName: string,
    trigger: ScheduleFlowTrigger,
    engine: FlowEngine,
  ): void {
    try {
      const job = new Cron(trigger.cron, async () => {
        try {
          await engine.startFlow(flowName, {
            _triggeredAt: new Date().toISOString(),
            _triggerType: "schedule",
            _cron: trigger.cron,
          });
        } catch (err) {
          this.logger.warn?.(`[TriggerBinding] Scheduled flow "${flowName}" failed: ${err}`);
        }
      });

      this.cronJobs.push(job);
    } catch (err) {
      this.logger.warn?.(
        `[TriggerBinding] Invalid cron "${trigger.cron}" for flow "${flowName}": ${err}`,
      );
    }
  }
}

// ── Factory ─────────────────────────────────────────────────

/** Create a new TriggerBinding connected to the given event bus */
export function createTriggerBinding(eventBus: EventBusLike, logger?: Logger): TriggerBinding {
  return new TriggerBindingImpl(eventBus, logger);
}
