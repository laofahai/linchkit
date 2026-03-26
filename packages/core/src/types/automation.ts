/**
 * Automation type definitions
 *
 * Reactive Automation: trigger-based automatic flow/action execution.
 * Automation = Trigger + Actions (one trigger → N sequential actions).
 */

import type { DeclarativeCondition } from "./rule";

// ── Automation triggers ────────────────────────────────

/** Trigger on a specific event type, optionally filtered */
export interface EventAutomationTrigger {
  type: "event";
  /** Event type name to listen for (e.g., "record.created") */
  eventType: string;
  /** Optional declarative filter applied to event payload */
  filter?: DeclarativeCondition;
}

/** Trigger on a time interval (basic scheduler) */
export interface ScheduleAutomationTrigger {
  type: "schedule";
  /** Cron expression (e.g., "0 9 * * MON") — basic interval support for now */
  cron: string;
}

/** Trigger when a specific field changes on a schema record */
export interface FieldChangeAutomationTrigger {
  type: "fieldChange";
  /** Schema name to watch */
  schema: string;
  /** Field name to monitor */
  field: string;
  /** Optional: trigger only when the field changes from this value */
  from?: unknown;
  /** Optional: trigger only when the field changes to this value */
  to?: unknown;
}

/** Trigger when a record's state changes */
export interface StateChangeAutomationTrigger {
  type: "stateChange";
  /** Schema name to watch */
  schema: string;
  /** Optional: trigger only when transitioning from this state */
  from?: string;
  /** Optional: trigger only when transitioning to this state */
  to?: string;
}

/** Trigger when a specific flow completes */
export interface FlowCompletedAutomationTrigger {
  type: "flowCompleted";
  /** Name of the source flow that must complete to trigger this automation */
  sourceFlow: string;
  /** Optional: only trigger on specific completion status (default: "completed") */
  status?: "completed" | "failed";
}

export type AutomationTrigger =
  | EventAutomationTrigger
  | ScheduleAutomationTrigger
  | FieldChangeAutomationTrigger
  | StateChangeAutomationTrigger
  | FlowCompletedAutomationTrigger;

// ── Automation actions ─────────────────────────────────

/** Execute a registered LinchKit action */
export interface ExecuteActionAutomationAction {
  type: "execute_action";
  /** Name of the action to execute */
  action: string;
  /** Input parameters for the action */
  input: Record<string, unknown>;
}

/** Start a registered flow */
export interface StartFlowAutomationAction {
  type: "start_flow";
  /** Name of the flow to start */
  flow: string;
  /** Input parameters for the flow */
  input: Record<string, unknown>;
}

/** Send a notification */
export interface SendNotificationAutomationAction {
  type: "send_notification";
  /** Channel identifier (e.g., "email", "slack", "webhook") */
  channel: string;
  /** Message content or template */
  message: string;
}

export type AutomationAction =
  | ExecuteActionAutomationAction
  | StartFlowAutomationAction
  | SendNotificationAutomationAction;

// ── Automation definition ──────────────────────────────

export interface AutomationDefinition {
  /** Unique automation name */
  name: string;
  /** Human-readable description */
  description?: string;
  /** The trigger that activates this automation */
  trigger: AutomationTrigger;
  /** Ordered list of actions to execute when triggered */
  actions: AutomationAction[];
  /** Whether the automation is active (default: true) */
  enabled: boolean;
}

// ── Automation execution result ────────────────────────

export interface AutomationExecutionResult {
  /** Name of the automation that ran */
  automation: string;
  /** Whether all actions executed successfully */
  success: boolean;
  /** Per-action results */
  actionResults: Array<{
    type: string;
    success: boolean;
    error?: string;
  }>;
  /** Total execution time in milliseconds */
  duration: number;
}
