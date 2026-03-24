# Event 设计规范

> 本文定义事件模型；事件在统一执行链中的产出时序见 `39_execution_contract.md`。

## 1. 定位

Event 是系统的驱动核心。它记录系统发生了什么，串联 Action、Rule、State、Execution 形成完整链路。

**没有统一事件模型，系统就只是一些散模块。**

## 2. 事件分类

### 2.1 框架自动事件（Runtime Events）

开发者不需要定义，框架在 Action 执行过程中自动产生。每种事件有明确的 payload 结构，Rule 的 filter 可据此做类型检查。

| 事件类型 | 时机 | payload 字段 |
|----------|------|-------------|
| `action.requested` | Action 收到请求 | action, schema, input, actor |
| `action.succeeded` | Action 执行成功 | action, schema, recordId, input, output, duration |
| `action.failed` | Action 执行失败 | action, schema, input, error(code + message) |
| `rule.evaluated` | Rule 被评估 | rule, action, result(passed/blocked/warned/approval_required), message |
| `rule.blocked` | Rule 阻止了操作 | rule, action, message, reason |
| `state.transition` | 状态发生迁移 | schema, recordId, from, to, action |
| `record.created` | 记录被创建 | schema, recordId, data |
| `record.updated` | 记录被更新 | schema, recordId, changedFields, before, after |
| `record.deleted` | 记录被删除 | schema, recordId, data |

框架升级改变 payload 结构时会产生编译期/Validation 警告，确保 Rule filter 和 EventHandler 不会因 payload 变更而静默失败。

### 2.2 变更事件（Change Events）

治理流程产生的事件：

| 事件类型 | 时机 |
|----------|------|
| `proposal.created` | 变更提案创建 |
| `proposal.validated` | 提案通过验证 |
| `proposal.approved` | 提案被批准 |
| `proposal.rejected` | 提案被拒绝 |
| `version.released` | 新版本发布 |
| `version.rolled_back` | 版本回滚 |

### 2.3 自定义事件

开发者或 AI 定义的业务事件：

```typescript
import { defineEvent } from '@linchkit/core'

export const stockBelowThreshold = defineEvent({
  name: 'inventory.stock_below_threshold',
  label: '库存低于阈值',

  payload: {
    product_id: { type: 'ref', target: 'product' },
    warehouse_id: { type: 'ref', target: 'warehouse' },
    current_stock: { type: 'number' },
    threshold: { type: 'number' },
  },
})
```

自定义事件通过 `ctx.emit()` 在 Action handler 中发出。

## 3. 事件统一结构

所有事件（自动的、变更的、自定义的）共享统一结构：

```typescript
{
  // 基本信息
  id: string,                          // 事件 ID (cuid2)
  type: string,                        // 事件类型，如 'action.succeeded'
  category: 'runtime' | 'change' | 'custom',

  // 时间
  timestamp: datetime,

  // 谁触发的
  actor: {
    type: 'human' | 'ai' | 'system' | 'worker' | 'timer',
    id: string,
  },

  // 关联信息
  schema?: string,                     // 相关 Schema
  record_id?: string,                  // 相关记录 ID
  action?: string,                     // 相关 Action
  capability: string,                  // 所属 Capability

  // 因果链
  execution_id: string,                // 所属执行链路
  caused_by?: string,                  // 由哪个事件引发

  // 数据
  payload: object,                     // 事件具体数据（JSONB 存储）

  // 版本
  capability_version: string,          // 事件发生时的 Capability 版本
}
```

## 4. 因果链

事件必须能追踪因果关系：

```
execution_id: "exec_001"

1. action.requested   { id: "evt_001" }
2. rule.evaluated     { id: "evt_002", caused_by: "evt_001" }
3. state.transition   { id: "evt_003", caused_by: "evt_001" }
4. action.succeeded   { id: "evt_004", caused_by: "evt_001" }
5. record.updated     { id: "evt_005", caused_by: "evt_004" }
```

同一个 `execution_id` 下的所有事件构成一条完整的执行链路，用于审计和回放。

## 5. 事件存储

- 存 Postgres 表，`payload` 用 JSONB
- 按时间分区（partition by month）以应对数据量增长
- 建索引：type、schema、record_id、execution_id、timestamp
- 事件不可修改、不可删除（append-only）

## 6. 事件消费

### 6.1 同步消费（进程内）

通过进程内 Event Bus（mitt/EventEmitter3）立即响应：
- Rule 触发（stateChange / fieldChange / event trigger）
- 同步副作用

### 6.2 异步消费（Outbox）

通过 Postgres Outbox 模式异步处理：
- 通知推送
- 索引更新
- 报表统计
- AI 分析

### 6.3 Outbox 模式

事件写入与业务操作在同一事务中，保证一致性：

```
事务内：
  1. 执行业务操作
  2. 写入 events 表
  3. 写入 outbox 表（待消费标记）

事务后：
  Worker 轮询 outbox 表，消费事件，执行异步任务
```

## 7. 与其他概念的关系

- **Action** → 产生事件（action.requested / succeeded / failed）
- **Rule** → 监听事件（trigger: { event: '...' }），评估时产生事件（rule.evaluated）
- **State** → 迁移时产生事件（state.transition）
- **Execution** → 每次 Action 执行的所有事件归属同一个 execution_id

## 8. 变更方式

- 自定义事件定义通过修改 TS 文件 → 构建 → 蓝绿部署
- 框架自动事件不可修改
- Source of truth 始终是 TS 文件 / Git
