/**
 * Automation Engine
 *
 * Listens to events, evaluates triggers, and executes automation actions.
 * Supports event-based, field-change, state-change, and schedule triggers.
 *
 * - Event triggers: subscribe to EventBus, match events against declarative filters
 * - Field/State change: subscribe to "record.updated" events, compare old/new values
 * - Schedule: basic interval support (parsed from cron "seconds" field or fixed interval)
 */

import { type ConditionContext, evaluateCondition } from "../engine/condition-evaluator";
import type { EventBusLike } from "../types/event";
import type {
  AutomationAction,
  AutomationDefinition,
  AutomationExecutionResult,
} from "../types/automation";
import type { EventRecord } from "../types/event";
import type { Logger } from "../types/logger";
import type { AutomationRegistry } from "./automation-registry";

// ── Action executor interface (avoids circular deps) ──

export interface AutomationActionExecutor {
  /** Execute a named action with given input. Returns action result. */
  executeAction(actionName: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface AutomationFlowStarter {
  /** Start a named flow with given input. */
  startFlow(flowName: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface AutomationNotifier {
  /** Send a notification to a channel. */
  notify(channel: string, message: string): Promise<void>;
}

// ── AutomationEngine interface ────────────────────────

export interface AutomationEngine {
  /** Start listening for events and schedules */
  start(): void;

  /** Stop all listeners and scheduled tasks */
  stop(): void;

  /** Manually trigger an automation by name (for testing) */
  triggerManually(
    automationName: string,
    payload: Record<string, unknown>,
  ): Promise<AutomationExecutionResult>;
}

// ── AutomationEngine options ──────────────────────────

export interface AutomationEngineOptions {
  registry: AutomationRegistry;
  eventBus: EventBusLike;
  logger?: Logger;
  /** Action executor — required for execute_action automation actions */
  actionExecutor?: AutomationActionExecutor;
  /** Flow starter — required for start_flow automation actions */
  flowStarter?: AutomationFlowStarter;
  /** Notifier — required for send_notification automation actions */
  notifier?: AutomationNotifier;
}

// ── Implementation ────────────────────────────────────

class AutomationEngineImpl implements AutomationEngine {
  private registry: AutomationRegistry;
  private eventBus: EventBusLike;
  private logger: Logger;
  private actionExecutor?: AutomationActionExecutor;
  private flowStarter?: AutomationFlowStarter;
  private notifier?: AutomationNotifier;

  private unsubscribers: Array<() => void> = [];
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private started = false;

  constructor(options: AutomationEngineOptions) {
    this.registry = options.registry;
    this.eventBus = options.eventBus;
    this.logger = options.logger ?? {
      info: () => {},
      warn: console.warn,
      error: console.error,
      debug: () => {},
    };
    this.actionExecutor = options.actionExecutor;
    this.flowStarter = options.flowStarter;
    this.notifier = options.notifier;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const automations = this.registry.getEnabled();
    for (const automation of automations) {
      this.bindAutomation(automation);
    }

    this.logger.info?.(
      `[AutomationEngine] Started with ${automations.length} enabled automation(s)`,
    );
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];

    this.started = false;
    this.logger.info?.("[AutomationEngine] Stopped");
  }

  async triggerManually(
    automationName: string,
    payload: Record<string, unknown>,
  ): Promise<AutomationExecutionResult> {
    const automation = this.registry.get(automationName);
    if (!automation) {
      return {
        automation: automationName,
        success: false,
        actionResults: [],
        duration: 0,
      };
    }
    return this.executeAutomation(automation, payload);
  }

  // ── Private: binding triggers ─────────────────────────

  private bindAutomation(automation: AutomationDefinition): void {
    const trigger = automation.trigger;

    switch (trigger.type) {
      case "event":
        this.bindEventTrigger(automation);
        break;

      case "fieldChange":
        this.bindFieldChangeTrigger(automation);
        break;

      case "stateChange":
        this.bindStateChangeTrigger(automation);
        break;

      case "schedule":
        this.bindScheduleTrigger(automation);
        break;
    }
  }

  private bindEventTrigger(automation: AutomationDefinition): void {
    const trigger = automation.trigger;
    if (trigger.type !== "event") return;

    const unsub = this.eventBus.subscribe(trigger.eventType, async (event: EventRecord) => {
      try {
        // Re-check enabled status at trigger time
        const current = this.registry.get(automation.name);
        if (!current?.enabled) return;

        // Evaluate declarative filter if present
        if (trigger.filter) {
          const ctx: ConditionContext = {
            target: event.payload,
            context: {},
            actor: { type: event.actor.type, id: event.actor.id, groups: [] },
          };
          if (!evaluateCondition(trigger.filter, ctx)) {
            return;
          }
        }

        const result = await this.executeAutomation(current, event.payload);
        if (!result.success) {
          this.logger.warn?.(
            `[AutomationEngine] Automation "${automation.name}" failed: ${JSON.stringify(result.actionResults.filter((r) => !r.success))}`,
          );
        }
      } catch (err) {
        this.logger.error?.(
          `[AutomationEngine] Unhandled error in "${automation.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.unsubscribers.push(unsub);
  }

  private bindFieldChangeTrigger(automation: AutomationDefinition): void {
    const trigger = automation.trigger;
    if (trigger.type !== "fieldChange") return;

    // Listen to record.updated events and check if the specified field changed
    const unsub = this.eventBus.subscribe("record.updated", async (event: EventRecord) => {
      try {
        const current = this.registry.get(automation.name);
        if (!current?.enabled) return;

        // Check schema match
        if (event.schema !== trigger.schema) return;

        const oldValues = event.payload._old as Record<string, unknown> | undefined;
        const newValues = event.payload._new as Record<string, unknown> | undefined;

        if (!oldValues || !newValues) return;

        const oldFieldValue = oldValues[trigger.field];
        const newFieldValue = newValues[trigger.field];

        // Field must have actually changed
        if (oldFieldValue === newFieldValue) return;

        // Check from/to constraints
        if (trigger.from !== undefined && oldFieldValue !== trigger.from) return;
        if (trigger.to !== undefined && newFieldValue !== trigger.to) return;

        const result = await this.executeAutomation(current, event.payload);
        if (!result.success) {
          this.logger.warn?.(
            `[AutomationEngine] Field change automation "${automation.name}" failed`,
          );
        }
      } catch (err) {
        this.logger.error?.(
          `[AutomationEngine] Unhandled error in "${automation.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.unsubscribers.push(unsub);
  }

  private bindStateChangeTrigger(automation: AutomationDefinition): void {
    const trigger = automation.trigger;
    if (trigger.type !== "stateChange") return;

    // Listen to record.updated events and check state field
    const unsub = this.eventBus.subscribe("record.updated", async (event: EventRecord) => {
      try {
        const current = this.registry.get(automation.name);
        if (!current?.enabled) return;

        // Check schema match
        if (event.schema !== trigger.schema) return;

        const oldValues = event.payload._old as Record<string, unknown> | undefined;
        const newValues = event.payload._new as Record<string, unknown> | undefined;

        if (!oldValues || !newValues) return;

        const oldState = oldValues._state as string | undefined;
        const newState = newValues._state as string | undefined;

        // State must have actually changed
        if (oldState === newState) return;

        // Check from/to constraints
        if (trigger.from !== undefined && oldState !== trigger.from) return;
        if (trigger.to !== undefined && newState !== trigger.to) return;

        const result = await this.executeAutomation(current, event.payload);
        if (!result.success) {
          this.logger.warn?.(
            `[AutomationEngine] State change automation "${automation.name}" failed`,
          );
        }
      } catch (err) {
        this.logger.error?.(
          `[AutomationEngine] Unhandled error in "${automation.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    this.unsubscribers.push(unsub);
  }

  private bindScheduleTrigger(automation: AutomationDefinition): void {
    const trigger = automation.trigger;
    if (trigger.type !== "schedule") return;

    // Basic interval: parse simple cron or use a fixed interval
    const intervalMs = parseCronToInterval(trigger.cron);
    if (intervalMs === null) {
      this.logger.warn?.(
        `[AutomationEngine] Cannot parse cron "${trigger.cron}" for automation "${automation.name}". ` +
          'Only basic patterns supported: "*/N * * * *" (every N minutes) or "0 */N * * *" (every N hours).',
      );
      return;
    }

    const interval = setInterval(async () => {
      const current = this.registry.get(automation.name);
      if (!current?.enabled) return;

      const result = await this.executeAutomation(automation, {
        _triggeredAt: new Date().toISOString(),
      });
      if (!result.success) {
        this.logger.warn?.(`[AutomationEngine] Scheduled automation "${automation.name}" failed`);
      }
    }, intervalMs);

    this.intervals.push(interval);
  }

  // ── Private: executing actions ────────────────────────

  private async executeAutomation(
    automation: AutomationDefinition,
    payload: Record<string, unknown>,
  ): Promise<AutomationExecutionResult> {
    const start = performance.now();
    const actionResults: AutomationExecutionResult["actionResults"] = [];

    for (const action of automation.actions) {
      try {
        await this.executeAction(action, payload);
        actionResults.push({ type: action.type, success: true });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        actionResults.push({ type: action.type, success: false, error: errorMessage });
        // Stop executing remaining actions on first failure
        break;
      }
    }

    const duration = performance.now() - start;
    const success = actionResults.every((r) => r.success);

    return {
      automation: automation.name,
      success,
      actionResults,
      duration,
    };
  }

  private async executeAction(
    action: AutomationAction,
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (action.type) {
      case "execute_action": {
        if (!this.actionExecutor) {
          throw new Error(
            "AutomationEngine: actionExecutor not configured. Cannot execute action.",
          );
        }
        // Merge event payload into action input for template-like access
        const input = { ...action.input, _event: payload };
        await this.actionExecutor.executeAction(action.action, input);
        break;
      }

      case "start_flow": {
        if (!this.flowStarter) {
          throw new Error("AutomationEngine: flowStarter not configured. Cannot start flow.");
        }
        const input = { ...action.input, _event: payload };
        await this.flowStarter.startFlow(action.flow, input);
        break;
      }

      case "send_notification": {
        if (!this.notifier) {
          throw new Error("AutomationEngine: notifier not configured. Cannot send notification.");
        }
        await this.notifier.notify(action.channel, action.message);
        break;
      }

      default:
        throw new Error(`Unknown automation action type: ${(action as AutomationAction).type}`);
    }
  }
}

// ── Cron parser (basic interval extraction) ────────────

/**
 * Parse basic cron patterns into millisecond intervals.
 * Supports:
 *   "* /N * * * *" → every N minutes (spaces added to avoid comment issue)
 *   "0 * /N * * *" → every N hours
 *   "* * * * *"    → every minute
 * Returns null for unsupported patterns.
 */
export function parseCronToInterval(cron: string): number | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = parts[0] as string;
  const hour = parts[1] as string;
  const dayOfMonth = parts[2] as string;
  const month = parts[3] as string;
  const dayOfWeek = parts[4] as string;

  // Only support patterns where day-of-month, month, and day-of-week are all wildcards
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
    return null;
  }

  // Every minute: "* * * * *"
  if (minute === "*" && hour === "*") {
    return 60 * 1000;
  }

  // Every N minutes: "*/N * * * *"
  if (minute.startsWith("*/") && hour === "*") {
    const n = Number.parseInt(minute.slice(2), 10);
    if (Number.isNaN(n) || n <= 0) return null;
    return n * 60 * 1000;
  }

  // Every N hours: "0 */N * * *"
  if (minute === "0" && hour.startsWith("*/")) {
    const n = Number.parseInt(hour.slice(2), 10);
    if (Number.isNaN(n) || n <= 0) return null;
    return n * 60 * 60 * 1000;
  }

  // Single hour: "0 N * * *" → every 24 hours (run at hour N, approximated)
  if (minute === "0" && /^\d+$/.test(hour)) {
    // Not a true interval — approximate to 24 hours
    return 24 * 60 * 60 * 1000;
  }

  return null;
}

// ── Factory ────────────────────────────────────────────

/** Create a new AutomationEngine */
export function createAutomationEngine(options: AutomationEngineOptions): AutomationEngine {
  return new AutomationEngineImpl(options);
}
