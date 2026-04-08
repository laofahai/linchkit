# Execution Log 设计规范

> Tracking milestones:
> - foundational observability reference
>
> Related issues:
> - No dedicated open issue is currently tracked for this spec.
>
> Execution source of truth: GitHub milestones and issues.

> 本文定义 Execution 的存储与查询；Execution 在统一执行链中的产生时机见 `39_execution_contract.md`。

## 1. 定位

Execution Log 记录每次 Action 执行的完整过程。它是：
- 审计依据 — 谁在什么时候做了什么
- 排查依据 — 出问题时能还原现场
- 回放依据 — 重放执行过程
- 观察数据源 — AI 分析系统行为的输入

## 2. Execution 结构

每次 Action 调用产生一个 Execution 记录：

```typescript
interface Execution {
  id: string                        // execution ID

  // 什么操作
  action: string                    // Action 名称
  capability: string                // 所属 Capability

  // 谁操作的
  actor: Actor

  // 操作什么
  schema: string                    // 目标 Schema
  recordId?: string                 // 目标记录 ID（已有记录时）

  // 输入输出
  input: object                     // Action 输入参数
  output?: object                   // Action 返回值

  // 执行结果
  status: 'succeeded' | 'failed' | 'blocked' | 'pending_approval'
  error?: {
    code: string
    message: string
    stack?: string                  // 仅开发环境
  }

  // Rule 评估结果
  rulesEvaluated: Array<{
    rule: string                    // Rule 名称
    result: 'passed' | 'blocked' | 'warned' | 'approval_required'
    message?: string
  }>

  // 状态变更
  stateTransition?: {
    from: string
    to: string
  }

  // 数据变更快照
  changes?: Array<{
    schema: string
    recordId: string
    type: 'create' | 'update' | 'delete'
    before?: object                 // 变更前（update/delete）
    after?: object                  // 变更后（create/update）
    changedFields?: string[]        // 变更的字段（update）
  }>

  // 触发的后续
  eventsEmitted: string[]           // 产生的事件 ID 列表
  childExecutions: string[]         // ctx.execute 触发的子 Execution ID

  // 性能
  duration: number                  // 执行耗时 (ms)

  // 版本
  capabilityVersion: string         // 执行时的 Capability 版本

  // 时间
  startedAt: datetime
  completedAt: datetime
}
```

## 3. 存储

- 存 Postgres 表
- `input`、`output`、`changes`、`rulesEvaluated` 等用 JSONB
- 按时间分区（partition by month）
- Execution 在 Action 事务提交后写入（不在事务内，避免拖慢 Action）
  - 但基础字段（id、action、actor、status）在事务内写入 outbox，保证不丢
  - 完整的 Execution 记录由 Worker 异步补全

## 4. 查询场景

| 场景 | 查询方式 |
|------|----------|
| 某条记录的操作历史 | WHERE schema = x AND record_id = y ORDER BY started_at |
| 某用户的操作记录 | WHERE actor.id = x |
| 某 Action 的执行统计 | WHERE action = x GROUP BY status |
| 失败的操作 | WHERE status = 'failed' |
| 被 Rule 拦截的操作 | WHERE status = 'blocked' |
| 某次执行的完整链路 | WHERE id = x，然后递归 childExecutions |

建索引：action、schema + record_id、actor.id、status、started_at。

## 5. 数据变更快照

`changes` 字段记录了这次 Action 对数据的所有修改。这对审计和回放至关重要：

```json
{
  "changes": [
    {
      "schema": "purchase_request",
      "recordId": "pr_001",
      "type": "update",
      "before": { "status": "draft", "amount": 5000 },
      "after": { "status": "submitted", "amount": 8000 },
      "changedFields": ["status", "amount"]
    }
  ]
}
```

这样即使不看 Event，也能知道这次 Action 改了什么。

## 6. 父子 Execution

当 Action handler 中调用 `ctx.execute()`（触发子 Action）时，形成 Execution 树：

```
Execution: complete_purchase (exec_001)
  ├── Execution: create_inbound (exec_002, parent: exec_001)
  └── Execution: send_notification (exec_003, parent: exec_001)
```

每个 Execution 记录 `parentExecutionId`，查询时可以还原完整执行树。

## 7. 保留策略

Execution Log 会持续增长，需要保留策略：

- **热数据**（近 3 个月）— 保留完整记录，可实时查询
- **温数据**（3-12 个月）— 保留完整记录，归档到分区表
- **冷数据**（12 个月以上）— 可压缩 / 导出到外部存储

具体保留时间可配置。

## 8. 与里程碑的关系

### M0
- 基础 Execution 记录（action、actor、input、output、status、duration）
- 不记录 changes 快照（简化实现）

### M1
- 完整 Execution 记录（含 changes 快照）
- 父子 Execution 链路
- 查询 API

### M3
- AI 分析 Execution 数据
- 异常检测
- 优化建议
