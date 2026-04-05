/**
 * Alert Delivery Channels — Concrete mechanisms for delivering fired alerts.
 *
 * Channels are pluggable transports that receive alert evaluation results
 * and deliver them via webhook, log, event bus, etc.
 */

import type { AlertEvaluationResult, SystemAlertDefinition } from "./alert-engine";

// ── Types ────────────────────────────────────────────────

export interface FiredAlert {
  result: AlertEvaluationResult;
  definition: SystemAlertDefinition;
}

export type AlertChannelType = "webhook" | "log" | "event";

export interface AlertChannel {
  /** Human-readable channel name */
  name: string;
  /** Channel transport type */
  type: AlertChannelType;
  /** Deliver a fired alert through this channel */
  send(alert: FiredAlert): Promise<void>;
}

// ── WebhookAlertChannel ─────────────────────────────────

export interface WebhookAlertChannelOptions {
  /** Target URL to POST alert payload */
  url: string;
  /** Optional custom headers */
  headers?: Record<string, string>;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
}

export class WebhookAlertChannel implements AlertChannel {
  readonly name: string;
  readonly type = "webhook" as const;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(name: string, options: WebhookAlertChannelOptions) {
    this.name = name;
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeout = options.timeout ?? 5000;
  }

  async send(alert: FiredAlert): Promise<void> {
    const payload = JSON.stringify({
      alert: alert.result.alert,
      severity: alert.result.severity,
      triggered: alert.result.triggered,
      actualValue: alert.result.actualValue,
      threshold: alert.result.threshold,
      timestamp: alert.result.timestamp,
      message: alert.definition.effect.message,
      label: alert.definition.label,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      await this.attemptSend(payload, controller.signal);
    } catch {
      // Retry once on failure
      try {
        await this.attemptSend(payload, controller.signal);
      } catch (retryErr) {
        // Swallow — channel failure must not crash the engine
        console.error(
          `[AlertChannel:${this.name}] webhook delivery failed after retry: ${retryErr}`,
        );
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async attemptSend(payload: string, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: payload,
      signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  }
}

// ── LogAlertChannel ─────────────────────────────────────

export class LogAlertChannel implements AlertChannel {
  readonly name: string;
  readonly type = "log" as const;

  constructor(name = "log") {
    this.name = name;
  }

  async send(alert: FiredAlert): Promise<void> {
    const msg = `[Alert:${alert.result.alert}] severity=${alert.result.severity} value=${alert.result.actualValue} threshold=${alert.result.threshold}${alert.definition.effect.message ? ` — ${alert.definition.effect.message}` : ""}`;

    if (alert.result.severity === "critical") {
      console.error(msg);
    } else {
      console.warn(msg);
    }
  }
}

// ── EventBusAlertChannel ────────────────────────────────

export type AlertEventEmitter = (event: {
  type: "system.alert.fired";
  payload: FiredAlert;
}) => void | Promise<void>;

export class EventBusAlertChannel implements AlertChannel {
  readonly name: string;
  readonly type = "event" as const;
  private readonly emit: AlertEventEmitter;

  constructor(name: string, emit: AlertEventEmitter) {
    this.name = name;
    this.emit = emit;
  }

  async send(alert: FiredAlert): Promise<void> {
    await this.emit({ type: "system.alert.fired", payload: alert });
  }
}

// ── AlertDispatcher ─────────────────────────────────────

/**
 * Dispatches fired alerts to all registered channels in parallel.
 * Individual channel failures are caught and logged — they never
 * prevent other channels from receiving the alert.
 */
export class AlertDispatcher {
  private channels: AlertChannel[] = [];

  /** Register a delivery channel */
  addChannel(channel: AlertChannel): void {
    this.channels.push(channel);
  }

  /** Remove a channel by name */
  removeChannel(name: string): void {
    this.channels = this.channels.filter((c) => c.name !== name);
  }

  /** List registered channels */
  listChannels(): AlertChannel[] {
    return [...this.channels];
  }

  /** Dispatch alert to all channels in parallel */
  async dispatch(alert: FiredAlert): Promise<void> {
    const results = await Promise.allSettled(this.channels.map((ch) => ch.send(alert)));

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "rejected") {
        console.error(
          `[AlertDispatcher] channel "${this.channels[i]!.name}" failed: ${(r as PromiseRejectedResult).reason}`,
        );
      }
    }
  }
}
