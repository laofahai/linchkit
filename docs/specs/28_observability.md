# 可观测性设计规范

## 1. 定位

可观测性不只是 Execution Log。系统需要 Metrics（指标）、Tracing（追踪）、Alerting（告警）三个维度。

## 2. 三个维度

### 2.1 Metrics（指标）

系统运行指标，用于监控和趋势分析。

#### 框架自动收集

| 指标 | 说明 |
|------|------|
| `action.count` | Action 执行次数（按 action name、status 分） |
| `action.duration` | Action 执行耗时（p50/p95/p99） |
| `action.error_rate` | Action 失败率 |
| `rule.block_count` | Rule 拦截次数 |
| `rule.evaluation_duration` | Rule 评估耗时 |
| `event.count` | 事件产生数量 |
| `outbox.pending` | Outbox 待处理数量 |
| `outbox.processing_duration` | Outbox 处理耗时 |
| `query.count` | GraphQL 查询次数 |
| `query.duration` | GraphQL 查询耗时 |
| `flow.active_count` | 活跃工作流数量 |
| `flow.completion_time` | 工作流完成时间 |

#### 存储

M0-M1：指标写 Postgres（简单 time-series 表）。
M3+：可选接入 Prometheus / InfluxDB。

### 2.2 Tracing（追踪）

已有的 Execution Log + Event 因果链（execution_id + caused_by）提供了完整的追踪能力。

补充：
- 每个 HTTP 请求 / MCP 调用分配 trace_id
- trace_id 贯穿整个调用链（Command Layer → Action → Rule → Event → EventHandler）
- 可选接入 OpenTelemetry

### 2.3 Alerting（告警）

基于指标的告警规则。**本身也是 Rule，但是系统级的。**

```typescript
// 系统级告警规则
defineSystemAlert({
  name: 'high_error_rate',
  condition: {
    metric: 'action.error_rate',
    operator: 'gt',
    value: 0.1,          // 错误率超过 10%
    window: '5m',         // 5 分钟窗口
  },
  effect: {
    notify: ['system_admin'],
    channel: 'email',     // 或 slack, webhook 等
  },
})

defineSystemAlert({
  name: 'outbox_backlog',
  condition: {
    metric: 'outbox.pending',
    operator: 'gt',
    value: 1000,
  },
  effect: {
    notify: ['system_admin'],
    severity: 'warning',
  },
})
```

## 3. Structured Logging

Application-level structured logging — distinct from Execution Log (audit trail) and Metrics (counters/gauges).

### 3.1 Log Levels

| Level | Usage |
|-------|-------|
| `error` | Unrecoverable failures, unhandled exceptions |
| `warn` | Degraded behavior, approaching limits, fallback activated |
| `info` | Key lifecycle events (server start, capability loaded, migration applied) |
| `debug` | Detailed execution flow (only in development or when explicitly enabled) |

### 3.2 Log Format (JSON)

All logs MUST be structured JSON. No plain-text `console.log` in production code.

```json
{
  "level": "error",
  "timestamp": "2026-04-09T12:00:00.000Z",
  "message": "Action execution failed",
  "traceId": "abc-123",
  "tenantId": "t_001",
  "context": {
    "action": "submit_request",
    "entity": "purchase_request",
    "actorId": "u_042"
  },
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Amount exceeds limit",
    "stack": "..."
  },
  "source": "server"
}
```

Required fields: `level`, `timestamp`, `message`, `source` (`server` | `client`).
Recommended fields: `traceId`, `tenantId`, `context`.

### 3.3 Log Sampling

| Level | Default sampling |
|-------|-----------------|
| `error` | 100% (never drop) |
| `warn` | 100% |
| `info` | 100% (production), configurable |
| `debug` | 0% (production), 100% (development) |

Sampling is configurable per tenant and per capability.

### 3.4 Log Shipping

```text
Server (Bun) → stdout (JSON) → Collector (Vector/Fluentd) → Storage (Loki/ES/Postgres)
Browser (React) → POST batch → /api/logs endpoint → Same pipeline
```

**Server logs:** Written to stdout as JSON lines. External collector handles shipping. LinchKit does NOT embed a log shipper.

**Client logs:** Batched and posted to `/api/logs` endpoint. Server validates, enriches with tenant/actor context, and merges into the same pipeline.

## 4. Frontend Observability

### 4.1 Error Capture

```typescript
// React Error Boundary — automatic capture
// Unhandled promise rejections — window.onunhandledrejection

interface ClientErrorLog {
  level: 'error' | 'warn';
  message: string;
  stack?: string;
  componentStack?: string;     // React component tree
  traceId?: string;            // From current request context
  url: string;                 // Current page URL
  userAgent: string;
  timestamp: string;
}
```

### 4.2 User Action Tracking

Record meaningful user actions for debugging and UX analysis. NOT fine-grained analytics — focus on what helps reproduce issues.

| Event | Fields |
|-------|--------|
| `page_view` | url, referrer, loadTime |
| `action_triggered` | actionName, entityName, source (button/shortcut/palette) |
| `form_submit` | entityName, validationErrors (count only, no PII) |
| `error_displayed` | errorCode, messageKey, componentName |

**Privacy rule:** Never log PII (field values, passwords, tokens). Log structural info only.
Client error payloads MUST use sanitized/templated message identifiers (no raw user-provided text).

### 4.3 Performance Metrics (Web Vitals)

| Metric | Description |
|--------|-------------|
| `LCP` | Largest Contentful Paint |
| `FID` | First Input Delay |
| `CLS` | Cumulative Layout Shift |
| `TTFB` | Time to First Byte |
| `INP` | Interaction to Next Paint |

Reported via `/api/logs` batch endpoint, tagged with `source: "client"` and `category: "web_vitals"`.

### 4.4 Frontend-Backend Trace Correlation

```text
Browser request
  → X-Trace-Id header (server-issued canonical ID)
  → Server logs with same traceId
  → Execution Log with same traceId
  → Client error logs with same traceId
```

Server returns `X-Trace-Id` in response headers. Client MUST reuse that value for subsequent client logs tied to the same request flow. Clients may generate a provisional `X-Trace-Id` only on the first request when no server ID is available yet, but MUST adopt the server-issued ID once received.

## 5. Log Lifecycle

### 5.1 Retention by Source

| Source | Hot (full) | Warm (indexed) | Cold (archived) |
|--------|-----------|----------------|-----------------|
| Server error/warn | 30 days | 90 days | 1 year |
| Server info | 7 days | 30 days | delete |
| Server debug | 1 day | delete | — |
| Client error | 30 days | 90 days | 1 year |
| Client action/vitals | 7 days | 30 days | delete |

Retention periods configurable per tenant.

### 5.2 Log Volume Budget

- Per-tenant daily log volume limit (configurable, default 100MB/day)
- Automatic sampling increase when approaching budget
- Alert when budget exceeded

## 6. System Health Check

```json
GET /api/health

{
  "status": "healthy",
  "checks": {
    "database": "ok",
    "outbox_worker": "ok",
    "temporal": "ok",
    "disk_space": "ok"
  },
  "metrics": {
    "uptime": "3d 12h",
    "active_flows": 23,
    "outbox_pending": 5
  }
}
```

## 7. Dashboard

System admin UI built-in Dashboard:

- Action execution stats (success/failure/duration)
- Rule block stats
- Outbox processing status
- Active workflows
- System resource usage
- **Client error rate and top errors** (from frontend logs)
- **Web Vitals summary** (LCP/FID/CLS by page)

## 8. Relationship with AI Evolution

Observability data feeds the AI Evolution System (Spec 55):

```text
Metrics + Events + Execution Logs + Client Logs
    ↓
AI Analysis (via Restate Flow)
    ↓
Discovery: Action error rate spike / Client error surge
    ↓
AI Suggestion: Add Rule, adjust validation, fix UI issue
    ↓
Proposal
```

## 9. Milestone Mapping

### M0 ✅
- Basic health check endpoint
- Action execution count and duration (Postgres)
- Structured logging (JSON format, trace context) — `source` field enforcement pending
- Metrics collection (InMemoryMetricsCollector)
- Alert engine (rising-edge detection, multi-channel)

### M1
- Complete Metrics collection
- System Dashboard
- traceId across full call chain
- **Structured logging format enforcement**
- **Client log ingestion endpoint (`/api/logs`)**
- **React Error Boundary auto-capture**

### M2
- Alert rules
- AI analyzing Metrics
- **Frontend user action tracking**
- **Web Vitals collection and reporting**
- **Frontend-Backend trace correlation (X-Trace-Id)**
- **Log retention policy enforcement (hot/warm/cold)**

### M3+
- OpenTelemetry integration
- External monitoring (Grafana / Prometheus)
- **Log volume budgets per tenant**
- **Full-stack log search by traceId**

## 10. M3 OpenTelemetry Integration

Tracking issue: **#130** (Spec 28 M3+).

This section defines the OTel surface area LinchKit core exposes and the
contracts a future `cap-otel` capability must honor. Phase 1 ships the
**seam only** — interfaces, a noop default, and a single demonstration
call site — without taking any `@opentelemetry/*` dependency in core.
Phase 2 ships the adapter capability + dashboards.

### 10.1 Phase 1 deliverables (this release)

- `Tracer` / `Span` / `Meter` / `Counter` / `Histogram` interfaces in
  `@linchkit/core` that mirror the shape of `@opentelemetry/api` (no
  hard dependency).
- `NoopTracer` + `NoopMeter` defaults — zero runtime cost.
- Module-level singleton: `getObservability()` / `setObservability()` /
  `resetObservability()` (the latter for tests).
- One demonstration span emitted from CommandLayer
  (`linchkit.command.dispatch`) so the seam is exercised by every
  request, not just in tests.

### 10.2 Phase 2 deliverables (follow-up issue)

- `cap-otel` capability (new addon) wrapping `@opentelemetry/api` +
  `@opentelemetry/sdk-trace-node` + `@opentelemetry/sdk-metrics` +
  `@opentelemetry/exporter-trace-otlp-http` and
  `@opentelemetry/exporter-metrics-otlp-http`.
- Pre-built Grafana dashboards committed under
  `docs/observability/grafana/` (JSON exports).
- Prometheus alert rules under `docs/observability/prometheus/`.
- A semantic-convention matrix that maps LinchKit attributes to OTel
  semantic conventions (`http.*`, `db.*`, `messaging.*`).
- Optional auto-instrumentation hooks for Bun/Elysia HTTP, Drizzle,
  and Restate.

### 10.3 Architecture sketch

```text
CommandLayer.execute(command)
  └─ withTrace(...)                            (already in place — LinchKit trace_id)
      └─ tracer.startSpan("linchkit.command.dispatch")
          ├─ middleware: pre                   → no span (Phase 2 adds per-slot spans)
          ├─ middleware: auth                  → span "linchkit.command.auth"
          ├─ exposure check
          ├─ middleware: permission            → span "linchkit.command.permission"
          ├─ middleware: tenant                → span "linchkit.command.tenant"
          ├─ middleware: pre-action            → span "linchkit.command.pre_action"
          ├─ executor.execute()
          │     └─ span "linchkit.action.<name>"
          │           ├─ rule evaluation       → child span "linchkit.rule.<name>"
          │           ├─ data provider write
          │           └─ event emission        → span "linchkit.event.<name>"
          │                 └─ EventHandler    → child span "linchkit.event_handler.<name>"
          │                       └─ may enqueue flow → span "linchkit.flow.<id>.<step>"
          └─ middleware: post-action           → span "linchkit.command.post_action"
```

Phase 1 only emits the outer `linchkit.command.dispatch` span. Phase 2
fills in the inner spans incrementally — each is an additive change at
its own call site, made possible by the seam.

### 10.4 Span naming convention

| Span | Where emitted |
|------|---------------|
| `linchkit.command.dispatch` | `CommandLayer.execute()` entry — **Phase 1** |
| `linchkit.command.<slot>` | Each pipeline slot (`auth`, `permission`, `tenant`, `pre_action`, `post_action`) — Phase 2 |
| `linchkit.action.<name>` | `ActionEngine.execute()` per action — Phase 2 |
| `linchkit.event.<name>` | EventBus emit — Phase 2 |
| `linchkit.event_handler.<name>` | EventHandler invocation — Phase 2 |
| `linchkit.flow.<flowId>.<step>` | Restate Flow step entry — Phase 2 |
| `linchkit.rule.<name>` | Rule evaluation when block/effect runs — Phase 2 |

Naming rules:
- Lowercase, dot-separated, ASCII only.
- Domain prefix is always `linchkit.` (avoids collision with auto-
  instrumentation that uses `http.*` / `db.*`).
- Action / event / handler / rule names are the user-defined entity
  identifiers (already validated `verb_noun` for actions, snake_case
  elsewhere) — safe to use verbatim.

### 10.5 Span attribute schema

Required on every span emitted by core:

| Attribute | Type | Notes |
|-----------|------|-------|
| `linchkit.command` | string | The command/action name (`linchkit.command.*` spans). |
| `linchkit.channel` | string | One of `http`, `mcp`, `cli`, `ui`, `internal`. |
| `linchkit.trace_id` | string | LinchKit internal trace ID (mirrors `X-Trace-Id`). Distinct from OTel `trace_id`; allows correlation with the existing Execution Log. |

Conditional (set when present on the request):

| Attribute | Type | Notes |
|-----------|------|-------|
| `linchkit.tenant_id` | string | Set by tenant middleware. Required for any span emitted after the tenant slot. |
| `linchkit.capability` | string | The capability that owns the action/entity (resolved via OntologyRegistry). |
| `linchkit.entity` | string | The target entity name when applicable. |
| `linchkit.action` | string | The action name (set on `linchkit.action.*` spans even though the prefix already names it — eases cross-span query). |
| `linchkit.actor.id` | string | Set on auth-completed spans only. |
| `linchkit.actor.type` | string | `human` / `system` / `agent`. |
| `linchkit.approval_id` | string | Set when re-executing an approval. |
| `linchkit.skip_action_slots` | boolean | Set on `onchange` dispatch. |

PII rule: NEVER set raw user input, password, or token fields as
attributes. Field names of failed validators are allowed (already used
elsewhere in the codebase for error context).

### 10.6 Trace propagation (HTTP + GraphQL)

| Transport | Inbound | Outbound |
|-----------|---------|----------|
| REST | Read W3C `traceparent` + `tracestate` from request headers; restore via `withTraceId` so the `X-Trace-Id` and OTel trace IDs share a parent. | Emit `traceparent` on any outgoing HTTP call from `cap-*` adapters. |
| GraphQL | Yoga plugin reads `traceparent`. | N/A (server-side only). |
| MCP | Adapter forwards `_traceparent` system meta when present. | Adapter sets `_traceparent` on tool invocations. |
| Restate | Phase 2: store `traceparent` in workflow state so resumed steps continue the same trace. | Phase 2. |

LinchKit's internal `X-Trace-Id` (Spec 28 §4.4) and the OTel
`trace_id` are kept in sync only at request boundaries — internally
each system uses its own ID for legacy compatibility (the Execution
Log writes the LinchKit ID; OTel exports its own ID).

### 10.7 OTLP exporter configuration (Phase 2)

Environment variables (standard OTel names):

| Var | Default | Notes |
|-----|---------|-------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _unset_ | When unset, the noop tracer/meter stay registered — **no network calls**. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `grpc` supported when the gRPC SDK is installed. |
| `OTEL_EXPORTER_OTLP_HEADERS` | _unset_ | Comma-separated `k=v` pairs for auth tokens. |
| `OTEL_SERVICE_NAME` | `linchkit` | Override per deployment. |
| `OTEL_SERVICE_VERSION` | package.json `version` | Read at startup. |
| `OTEL_RESOURCE_ATTRIBUTES` | `linchkit.tenant_mode=multi` | Caller may append. |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` (dev) / `0.1` (prod default) | Tunable. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` (ms) | |

Defaults are designed so a Phase 2 install with **no env vars set**
behaves like Phase 1: noop only, no exporter, zero network traffic.

### 10.8 Metric set

LinchKit-defined OTel instruments (Phase 2 — names finalize when the
adapter ships):

| Instrument | Type | Unit | Attributes |
|------------|------|------|------------|
| `linchkit.commands.duration` | histogram | `ms` | `command`, `channel`, `status` |
| `linchkit.actions.invoked` | counter | `1` | `action`, `status`, `tenant_id` |
| `linchkit.events.processed` | counter | `1` | `event`, `status` (`success` / `error`), `handler` |
| `linchkit.replay.batch.size` | histogram | `1` | `source` (`outbox` / `worker`) |
| `linchkit.rules.blocked` | counter | `1` | `rule`, `entity` |
| `linchkit.flow.active` | gauge (observable) | `1` | `flow_id` |

These overlap with the existing in-process `MetricsCollector` metrics
on purpose: the adapter subscribes to the in-process collector and
forwards observations to OTel — one direction of data flow, no double
counting.

### 10.9 Future Phase 2

- Pre-built Grafana dashboards committed under
  `docs/observability/grafana/` (JSON exports for: Command Overview,
  Action Drilldown, Event Pipeline, Tenant Comparison).
- Prometheus alert rules under `docs/observability/prometheus/` (high
  error rate, p99 regression, outbox backlog, flow stalled).
- Semantic conventions matrix mapping LinchKit attributes to OTel
  `http.*`, `db.*`, `messaging.*` where overlap exists.
- Auto-instrumentation for Elysia, Drizzle, and Restate.
- `OTEL_SDK_DISABLED=true` honored by the adapter to fall back to noop
  without uninstalling.
