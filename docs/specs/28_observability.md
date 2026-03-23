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

## 3. 系统健康检查

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

## 4. Dashboard

系统管理 UI 中内置 Dashboard：

- Action 执行统计（成功/失败/耗时）
- Rule 拦截统计
- Outbox 处理状态
- 活跃工作流
- 系统资源使用

## 5. 与 AI 进化的关系

Observability 数据是 AI 进化（Evolution System）的输入：

```
Metrics + Events + Execution Logs
    ↓
AI 分析（通过 Restate Flow）
    ↓
发现：某个 Action 错误率突增
    ↓
AI 建议：增加 Rule 或修改校验逻辑
    ↓
Proposal
```

## 6. 与里程碑的关系

### M0
- 基础健康检查端点
- Action 执行计数和耗时（Postgres）

### M1
- 完整 Metrics 收集
- 系统 Dashboard
- trace_id 贯穿调用链

### M2
- 告警规则
- AI 分析 Metrics

### M3+
- OpenTelemetry 接入
- 外部监控集成（Grafana / Prometheus）
