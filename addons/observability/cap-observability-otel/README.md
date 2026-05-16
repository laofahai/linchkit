# @linchkit/cap-observability-otel

OpenTelemetry adapter for LinchKit's observability seam (Spec 28 M3, issue
[#130](https://github.com/laofahai/linchkit/issues/130)).

## What it is

`@linchkit/core` ships a vendor-neutral observability seam — `Tracer`,
`Span`, `Meter`, `Counter`, `Histogram`, and an `Observability` registry
in `packages/core/src/observability/`. By default the registry is a
no-op so instrumented call sites pay zero runtime cost.

This capability provides:

1. **`createOtelAdapter()`** — wraps `@opentelemetry/api`'s tracer +
   meter so they satisfy the LinchKit interface.
2. **`bootstrapNodeSdk()`** — convenience helper that constructs a
   `NodeSDK` with the OTLP/HTTP trace + metric exporters wired up.

The two helpers are decoupled on purpose: the adapter has no Node-SDK
dependency at the type level, and the bootstrap helper never auto-runs.
The host application calls both explicitly.

## When to use

Use this capability when you want LinchKit's instrumented call sites
(CommandLayer, ActionEngine, EventHandlers, Flow steps) to emit OTLP
traces and metrics to your collector. Skip it in development /
single-tenant deployments where the no-op default is enough.

## Install

```bash
bun add @linchkit/cap-observability-otel
```

Peer dependencies you must also install in the host:

- `@linchkit/core` `^0.2.0`
- `@opentelemetry/api` `^1.9.0`

## Bootstrap example

```ts
import { setObservability } from "@linchkit/core/server";
import {
  bootstrapNodeSdk,
  createOtelAdapter,
} from "@linchkit/cap-observability-otel";

// 1. Construct + start the NodeSDK. This registers global providers
//    so `trace.getTracer(...)` / `metrics.getMeter(...)` resolve to
//    the real exporters instead of OTel's built-in no-ops.
const sdk = bootstrapNodeSdk({
  serviceName: "linchkit-server",
  serviceVersion: "0.2.0",
  // Optional — falls back to OTEL_EXPORTER_OTLP_ENDPOINT env var
  endpoint: "http://localhost:4318",
});
sdk.start();

// 2. Swap LinchKit's observability registry so every call site that
//    uses `getObservability().tracer / .meter` flows through OTel.
setObservability(createOtelAdapter({ serviceName: "linchkit-server" }));

// 3. Graceful shutdown — handle both SIGTERM (orchestrators) and
//    SIGINT (Ctrl-C) so spans + metrics flush before exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await sdk.shutdown();
    process.exit(0);
  });
}
```

## Environment variables

The OTLP/HTTP exporters honour the standard OpenTelemetry environment
variables. The most relevant ones:

| Variable | Purpose | Default |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP/HTTP endpoint. Used when `bootstrapNodeSdk({ endpoint })` is omitted; `v1/traces` and `v1/metrics` are appended automatically. | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Per-signal trace endpoint. Used verbatim — overrides both the base env var and the `endpoint` option. | unset |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Per-signal metric endpoint. Used verbatim — overrides both the base env var and the `endpoint` option. | unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `k=v` request headers (e.g. auth tokens). | unset |
| `OTEL_SERVICE_NAME` | Used by the SDK as a fallback `service.name`. The `serviceName` option in this package takes precedence. | unset |
| `OTEL_LOG_LEVEL` | Internal SDK log level (`debug`, `info`, `warn`, `error`). | `info` |

See the [OpenTelemetry environment variable
spec](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/)
for the full list.

## What ships in Phase 1 (this release)

- [x] `Tracer` + `Span` adapter (`startSpan`, `setAttribute(s)`,
      `recordException`, `setStatus`, `end`)
- [x] `Meter` + `Counter` + `Histogram` adapter
- [x] `bootstrapNodeSdk()` with OTLP/HTTP trace + metric exporters
- [x] Capability descriptor (`autoInstall: false` — explicit opt-in)

## Out of scope for Phase 1

- OTel `Context` propagation — call sites use the returned `Span`
  handle directly with `try { ... } finally { span.end() }`.
- Auto-instrumentation of HTTP / fs / pg / redis libraries — install
  `@opentelemetry/auto-instrumentations-node` separately if needed.
- Logs exporter — Spec 28 ships logs through the existing
  `StructuredLogger` interface; OTLP logs export is a follow-up.

## Related

- Spec 28 — Observability seam
- Issue [#130](https://github.com/laofahai/linchkit/issues/130) — OTel
  adapter delivery
- `packages/core/src/observability/observability-registry.ts` — the
  registry this adapter plugs into
