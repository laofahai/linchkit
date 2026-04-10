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

```
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

```
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
- Structured logging (JSON format, trace context)
- Metrics collection (InMemoryMetricsCollector)
- Alert engine (rising-edge detection, multi-channel)

### M1
- Complete Metrics collection
- System Dashboard
- trace_id across full call chain
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
