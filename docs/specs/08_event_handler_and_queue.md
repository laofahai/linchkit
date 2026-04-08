# EventHandler 与队列设计规范

> Tracking milestones:
> - foundational runtime architecture reference
>
> Related issues:
> - No dedicated open issue is currently tracked for this spec.
>
> Execution source of truth: GitHub milestones and issues.

## 1. 定位

EventHandler 负责事件的后续处理。当 Action 产生事件后，EventHandler 监听并执行后续逻辑（通知、联动、统计等）。

**Rule 管"能不能做"，EventHandler 管"做了之后还要做什么"。**

## 2. EventHandler 定义

```typescript
import { defineEventHandler } from '@linchkit/core'

// 异步处理（通过 Outbox，不阻塞 Action）
export const notifyApprover = defineEventHandler({
  name: 'notify_approver_on_submit',
  label: '提交后通知审批人',

  listen: 'action.succeeded',
  filter: { action: 'submit_request' },

  async: true,

  handler: async (event, ctx) => {
    const request = await ctx.get('purchase_request', event.record_id)
    await ctx.execute('send_notification', {
      to: request.department.manager,
      template: 'new_purchase_request',
      data: { title: request.title, amount: request.amount },
    })
  },
})

// 同步处理（在事务内，和 Action 一起成功或失败）
export const syncHandler = defineEventHandler({
  name: 'sync_example',
  listen: 'state.transition',
  filter: { schema: 'purchase_request', to: 'approved' },

  async: false,

  handler: async (event, ctx) => {
    // 在 Action 的事务内执行
  },
})
```

## 3. EventHandler 完整结构

```typescript
defineEventHandler({
  name: string,              // 唯一标识
  label: string,             // 人类可读名称
  description?: string,      // 详细说明

  // 监听什么事件
  listen: string,            // 事件类型
  filter?: object,           // 过滤条件（匹配事件的 payload）

  // 同步还是异步
  async: boolean,            // true = Outbox 异步, false = 事务内同步

  // 执行逻辑
  handler: (event: Event, ctx: ActionContext) => Promise<void>,

  // 异步处理策略（仅 async: true 时有效）
  retryPolicy?: {
    maxRetries: number,              // 默认 3
    backoff: 'fixed' | 'exponential', // 默认 exponential
    initialDelay: number,            // 默认 60 (秒)
  },

  // 优先级
  priority?: number,         // 同一事件有多个 handler 时的执行顺序
})
```

## 4. Rule vs EventHandler

| | Rule | EventHandler |
|--|------|-------------|
| 用途 | 判断、拦截、裁决 | 后续处理、副作用 |
| 能阻止操作吗 | 能（block / require_approval） | 不能 |
| 执行时机 | Action 执行前/中 | Action 执行后（事件触发） |
| 同步/异步 | 必须同步 | 可选 |
| 失败影响 | Rule block = Action 失败 | 异步 handler 失败不影响 Action |

## 5. 事件处理完整流程

```
Action 执行
    │
    ├── 1. 产生 action.requested 事件
    │
    ├── 2. Rule 评估（同步，所有 Rule 在事务内）
    │       → block? 终止
    │       → require_approval? 挂起
    │       → 通过? 继续
    │
    ├── 3. 执行 Action 逻辑（handler 或声明式）
    │
    ├── 4. 产生后续事件（state.transition, record.updated 等）
    │
    ├── 5. 同步 EventHandler 执行（在事务内）
    │
    ├── 6. 异步 EventHandler 的事件写入 Outbox（在事务内）
    │
    ├── 7. 提交事务
    │
    └── 8. Worker 从 Outbox 消费，执行异步 EventHandler
```

## 6. 事件递归保护

EventHandler 可以触发新的 Action，新 Action 又产生新事件，可能形成无限链。

**保护机制**：

- **最大传播深度**：默认 10 层。每次事件传播时 `depth + 1`，超过上限自动终止并记录 `SystemError`
- **深度通过 execution context 传递**：同一条执行链路内共享 depth 计数器
- **循环检测**：如果同一个 `{eventType, recordId}` 组合在同一条链路中出现两次，立即终止并记录警告
- **可配置**：通过 `linchkit.config.ts` 中的 `event.maxDepth` 调整上限

```
Event A → Handler → Action → Event B → Handler → Action → Event C → ...
depth=1    depth=2    depth=3    depth=4    ...    depth=10 → 终止
```

## 7. Outbox 设计

### 6.1 为什么用 Outbox

保证"业务成功 → 异步事件一定被处理"。

事件写入和业务操作在同一个事务中：
- 事务成功 → 业务数据和 outbox 记录都持久化
- 事务失败 → 两者都回滚，不会出现"事件发了但业务没成功"

### 6.2 Outbox 表结构

```sql
CREATE TABLE outbox (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(id),
  handler_name    TEXT NOT NULL,        -- 哪个 EventHandler 处理

  -- 状态
  status          TEXT NOT NULL DEFAULT 'pending',
                  -- pending / processing / completed / failed / dead

  -- 重试
  retry_count     INTEGER DEFAULT 0,
  max_retries     INTEGER DEFAULT 3,
  next_retry_at   TIMESTAMP,

  -- Worker 领取
  claimed_by      TEXT,                 -- Worker 实例 ID
  claimed_at      TIMESTAMP,

  -- 结果
  completed_at    TIMESTAMP,
  error           JSONB,               -- 失败原因

  -- 排序
  partition_key   TEXT,                 -- 通常是 record_id，保证同记录顺序处理

  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON outbox (status, next_retry_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_outbox_partition ON outbox (partition_key, created_at);
```

### 6.3 Worker 消费流程

```
1. 查询：SELECT * FROM outbox
         WHERE status IN ('pending', 'failed')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
         AND (claimed_by IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
         ORDER BY created_at
         LIMIT 10
         FOR UPDATE SKIP LOCKED

2. 领取：UPDATE outbox SET claimed_by = $worker_id, claimed_at = NOW(), status = 'processing'

3. 执行 handler

4. 成功：UPDATE outbox SET status = 'completed', completed_at = NOW()
   失败：UPDATE outbox SET status = 'failed',
         retry_count = retry_count + 1,
         next_retry_at = NOW() + backoff(retry_count),
         error = $error
   超过 max_retries：UPDATE outbox SET status = 'dead'
```

### 6.4 失败重试策略

指数退避（默认）：
- 第 1 次失败：1 分钟后重试
- 第 2 次失败：5 分钟后重试
- 第 3 次失败：30 分钟后重试
- 超过 max_retries：标记为 dead，等待人工处理

### 6.5 顺序保证

通过 `partition_key` 保证同一记录的事件顺序处理：
- 同一 partition_key 的 outbox 记录按 created_at 顺序消费
- 前一条未完成时，后一条不会被领取

### 6.6 蓝绿部署兼容

- 旧实例的 Worker：继续处理已领取的任务，完成后停止
- 新实例的 Worker：领取新任务
- `claimed_by` 字段区分不同实例
- `claimed_at` 超时（5 分钟）后释放，防止 Worker 崩溃导致任务卡死

## 7. M0 vs 后续

### M0
- 进程内事件分发（mitt/EventEmitter3）
- 同步 EventHandler 在事务内
- 异步 EventHandler 通过 Postgres Outbox + 同进程 Worker 轮询
- 单 Worker，不需要并发控制

### M1+
- 多 Worker 实例（蓝绿部署天然有两个）
- 并发控制（FOR UPDATE SKIP LOCKED）
- 死信处理 UI

### M2+（如果需要）
- 替换为 BullMQ（Redis-backed）
- 更实时的消费（pub/sub 而非轮询）
- 优先级队列、延迟队列
- 但 Outbox 写入不变（保证事务一致性），BullMQ 作为消费端替代轮询

## 8. 轮询间隔

M0 默认 1 秒轮询一次。

可配置：
```typescript
// linchkit.config.ts
export default defineConfig({
  queue: {
    pollInterval: 1000,      // ms
    batchSize: 10,           // 每次取多少条
    claimTimeout: 5 * 60,    // 秒，领取超时
  },
})
```
