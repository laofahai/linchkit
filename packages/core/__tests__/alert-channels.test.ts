/**
 * Alert delivery channels tests — WebhookAlertChannel, LogAlertChannel,
 * EventBusAlertChannel, AlertDispatcher.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  AlertDispatcher,
  EventBusAlertChannel,
  type FiredAlert,
  LogAlertChannel,
  WebhookAlertChannel,
} from "../src/observability/alert-channels";
import { AlertEngine, defineSystemAlert } from "../src/observability/alert-engine";
import { InMemoryMetricsCollector } from "../src/observability/metrics";

// ── Fixtures ──────────────────────────────────────────────

function makeFiredAlert(overrides?: Partial<FiredAlert>): FiredAlert {
  return {
    result: {
      alert: "high_error_rate",
      triggered: true,
      actualValue: 150,
      threshold: 100,
      severity: "critical",
      timestamp: new Date().toISOString(),
    },
    definition: defineSystemAlert({
      name: "high_error_rate",
      label: "High Error Rate",
      condition: { metric: "errors", operator: "gt", value: 100 },
      effect: {
        notify: ["ops-team"],
        severity: "critical",
        message: "Error rate exceeded threshold",
      },
    }),
    ...overrides,
  };
}

// ── WebhookAlertChannel ──────────────────────────────────

describe("WebhookAlertChannel", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST with correct JSON payload", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = mock(async (url: any, init: any) => {
      calls.push({ url: url as string, init });
      return new Response("OK", { status: 200 });
    }) as any;

    const channel = new WebhookAlertChannel("ops-webhook", {
      url: "https://hooks.example.com/alert",
      headers: { "X-Token": "secret" },
    });
    const alert = makeFiredAlert();
    await channel.send(alert);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hooks.example.com/alert");
    expect(calls[0].init.method).toBe("POST");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Token"]).toBe("secret");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.alert).toBe("high_error_rate");
    expect(body.severity).toBe("critical");
    expect(body.actualValue).toBe(150);
    expect(body.threshold).toBe(100);
    expect(body.message).toBe("Error rate exceeded threshold");
    expect(body.label).toBe("High Error Rate");
  });

  it("retries once on failure then succeeds", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("OK", { status: 200 });
    }) as any;

    const channel = new WebhookAlertChannel("retry-test", {
      url: "https://hooks.example.com/alert",
    });
    // Should not throw — first attempt fails (500), retry succeeds
    await channel.send(makeFiredAlert());
    expect(callCount).toBe(2);
  });

  it("does not throw when both attempts fail", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Server Error", { status: 500 });
    }) as any;

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const channel = new WebhookAlertChannel("fail-test", {
      url: "https://hooks.example.com/alert",
    });

    // Should not throw
    await channel.send(makeFiredAlert());
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ── LogAlertChannel ──────────────────────────────────────

describe("LogAlertChannel", () => {
  it("logs critical alerts via console.error", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const channel = new LogAlertChannel("log");
    await channel.send(makeFiredAlert());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const msg = errorSpy.mock.calls[0][0] as string;
    expect(msg).toContain("high_error_rate");
    expect(msg).toContain("critical");
    expect(msg).toContain("150");
    errorSpy.mockRestore();
  });

  it("logs warning alerts via console.warn", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const alert = makeFiredAlert({
      result: {
        alert: "slow_response",
        triggered: true,
        actualValue: 2000,
        threshold: 1000,
        severity: "warning",
        timestamp: new Date().toISOString(),
      },
      definition: defineSystemAlert({
        name: "slow_response",
        condition: { metric: "latency_p95", operator: "gt", value: 1000 },
        effect: { notify: ["ops"], severity: "warning" },
      }),
    });

    const channel = new LogAlertChannel();
    await channel.send(alert);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("slow_response");
    expect(msg).toContain("warning");
    warnSpy.mockRestore();
  });
});

// ── EventBusAlertChannel ─────────────────────────────────

describe("EventBusAlertChannel", () => {
  it("emits system.alert.fired event with payload", async () => {
    const emitted: any[] = [];
    const emit = mock(async (event: any) => {
      emitted.push(event);
    });

    const channel = new EventBusAlertChannel("event-bus", emit);
    const alert = makeFiredAlert();
    await channel.send(alert);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("system.alert.fired");
    expect(emitted[0].payload.result.alert).toBe("high_error_rate");
    expect(emitted[0].payload.definition.name).toBe("high_error_rate");
  });
});

// ── AlertDispatcher ──────────────────────────────────────

describe("AlertDispatcher", () => {
  it("dispatches to multiple channels in parallel", async () => {
    const received: string[] = [];
    const ch1: any = {
      name: "ch1",
      type: "log",
      send: mock(async () => {
        received.push("ch1");
      }),
    };
    const ch2: any = {
      name: "ch2",
      type: "log",
      send: mock(async () => {
        received.push("ch2");
      }),
    };

    const dispatcher = new AlertDispatcher();
    dispatcher.addChannel(ch1);
    dispatcher.addChannel(ch2);

    await dispatcher.dispatch(makeFiredAlert());
    expect(received).toContain("ch1");
    expect(received).toContain("ch2");
    expect(ch1.send).toHaveBeenCalledTimes(1);
    expect(ch2.send).toHaveBeenCalledTimes(1);
  });

  it("handles channel failure gracefully — other channels still fire", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const received: string[] = [];
    const failCh: any = {
      name: "fail-ch",
      type: "webhook",
      send: mock(async () => {
        throw new Error("connection refused");
      }),
    };
    const okCh: any = {
      name: "ok-ch",
      type: "log",
      send: mock(async () => {
        received.push("ok-ch");
      }),
    };

    const dispatcher = new AlertDispatcher();
    dispatcher.addChannel(failCh);
    dispatcher.addChannel(okCh);

    // Should not throw
    await dispatcher.dispatch(makeFiredAlert());

    expect(received).toContain("ok-ch");
    expect(okCh.send).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("addChannel / removeChannel / listChannels work correctly", () => {
    const dispatcher = new AlertDispatcher();
    const ch: any = { name: "test", type: "log", send: async () => {} };
    dispatcher.addChannel(ch);
    expect(dispatcher.listChannels()).toHaveLength(1);
    dispatcher.removeChannel("test");
    expect(dispatcher.listChannels()).toHaveLength(0);
  });
});

// ── AlertEngine + Dispatcher integration ─────────────────

describe("AlertEngine dispatcher integration", () => {
  it("dispatches through AlertDispatcher when alert fires", async () => {
    const metrics = new InMemoryMetricsCollector();
    const dispatched: FiredAlert[] = [];
    const dispatcher = new AlertDispatcher();
    dispatcher.addChannel({
      name: "test-ch",
      type: "event",
      send: async (alert) => {
        dispatched.push(alert);
      },
    });

    const engine = new AlertEngine({ metrics, dispatcher });
    engine.register(
      defineSystemAlert({
        name: "high_cpu",
        condition: { metric: "cpu_usage", operator: "gt", value: 80 },
        effect: { notify: ["ops"], severity: "warning" },
      }),
    );

    metrics.gauge("cpu_usage", 90);
    engine.evaluateAll();

    // Give dispatcher async dispatch a tick to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].result.alert).toBe("high_cpu");
    expect(dispatched[0].result.triggered).toBe(true);
  });

  it("setDispatcher allows late binding", async () => {
    const metrics = new InMemoryMetricsCollector();
    const engine = new AlertEngine({ metrics });

    const dispatched: FiredAlert[] = [];
    const dispatcher = new AlertDispatcher();
    dispatcher.addChannel({
      name: "late-ch",
      type: "log",
      send: async (alert) => {
        dispatched.push(alert);
      },
    });

    engine.setDispatcher(dispatcher);
    engine.register(
      defineSystemAlert({
        name: "mem_high",
        condition: { metric: "mem", operator: "gte", value: 90 },
        effect: { notify: ["ops"], severity: "critical" },
      }),
    );

    metrics.gauge("mem", 95);
    engine.evaluateAll();
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].result.alert).toBe("mem_high");
  });
});
