# 响应式自动化 — 数据条件触发

> Status: Draft | Date: 2026-03-23
> 灵感来源: Palantir Automate（对象集条件触发、阈值越界）
> 里程碑: M3

## 1. 问题

LinchKit 当前的自动化是**纯事件驱动**的：EventHandler 在 Action 成功或状态迁移时触发。这遗漏了一类重要的自动化场景：

**数据条件触发** — 「当数据达到某种状态时，执行 X」。

以下场景无法用当前 EventHandler 表达：
- 「当某部门待审批的采购申请总额超过 ¥100,000 时，通知 CFO」
- 「当库存数量低于安全库存时，自动创建采购申请」
- 「当申请在 submitted 状态停留超过 48 小时时，升级处理」
- 「每周一 9 点，如果有超过 3 天未审批的申请，发送摘要」

这些需要：
1. 轮询 + 条件评估（定时）
2. 聚合感知触发器（Action 后评估）
3. 时间 + 数据条件组合

## 2. 方案：defineWatcher

引入 `defineWatcher` — 将数据条件与自动化动作组合的声明。Watcher 在定时或相关数据变更后被评估。

```typescript
import { defineWatcher } from '@linchkit/core'

export const budgetAlert = defineWatcher({
  name: 'department_budget_alert',
  label: '部门支出超预算告警',

  // 监视什么
  watch: {
    schema: 'purchase_request',
    filter: { status: { in: ['submitted', 'approved'] } },
    aggregate: { field: 'amount', op: 'sum', groupBy: 'department_id' },
  },

  // 何时触发
  trigger: {
    type: 'threshold',
    condition: { gt: 100_000 },      // sum(amount) > 100,000
    // 每组仅触发一次，直到条件重置
    debounce: 'once_until_reset',
  },

  // 做什么
  effect: {
    action: 'send_notification',
    params: (context) => ({
      to: context.group.department.manager,
      template: 'budget_exceeded',
      data: { department: context.group.department_id, total: context.value },
    }),
  },
})
```

## 3. Watcher 类型

### 3.1 阈值 Watcher

当聚合值越过边界时触发。

```typescript
defineWatcher({
  name: 'low_inventory_alert',
  watch: {
    schema: 'inventory_item',
    filter: {},               // 所有项
    // 无聚合 — 监视单条记录
  },
  trigger: {
    type: 'threshold',
    field: 'quantity',
    condition: { lt: '$reorder_point' },  // 字段引用
    debounce: 'once_until_reset',
  },
  effect: {
    action: 'create_purchase_request',
    params: (ctx) => ({
      item_id: ctx.record.id,
      quantity: ctx.record.reorder_quantity,
    }),
  },
})
```

### 3.2 过期 Watcher

当记录在某种状态停留过久时触发。

```typescript
defineWatcher({
  name: 'stale_request_escalation',
  watch: {
    schema: 'purchase_request',
    filter: { status: 'submitted' },
  },
  trigger: {
    type: 'staleness',
    field: 'updated_at',
    threshold: '48h',          // 48 小时后视为过期
  },
  effect: {
    action: 'escalate_request',
    params: (ctx) => ({ id: ctx.record.id }),
  },
})
```

### 3.3 定时 + 条件 Watcher

按时间表评估条件。

```typescript
defineWatcher({
  name: 'weekly_unapproved_digest',
  watch: {
    schema: 'purchase_request',
    filter: { status: 'submitted' },
    // 条件：count > 0
  },
  trigger: {
    type: 'schedule',
    cron: '0 9 * * 1',        // 每周一 9 点
    condition: { count: { gt: 0 } },
  },
  effect: {
    action: 'send_digest',
    params: (ctx) => ({
      requests: ctx.records,
      count: ctx.count,
    }),
  },
})
```

### 3.4 集合变更 Watcher

当记录进入或离开过滤集合时触发（灵感来自 Palantir Automate）。

```typescript
defineWatcher({
  name: 'new_high_value_request',
  watch: {
    schema: 'purchase_request',
    filter: { amount: { gt: 50_000 }, status: 'submitted' },
  },
  trigger: {
    type: 'set_change',
    on: 'added',               // 'added' | 'removed' | 'modified'
  },
  effect: {
    action: 'send_notification',
    params: (ctx) => ({
      to: 'cfo@company.com',
      template: 'high_value_request',
      data: { id: ctx.record.id, amount: ctx.record.amount },
    }),
  },
})
```

## 4. 评估策略

Watcher 需要评估机制。两种模式：

### 4.1 Action 后评估（响应式）

任何修改被监视 Schema 的 Action 执行后，评估相关 Watcher：

```
Action 在 Schema X 上执行
  → 查找 watch.schema == X 的 Watcher
  → 评估每个 Watcher 的条件
  → 条件满足 → 执行 effect
```

轻量且即时，但只能捕获通过 Action 的变更（不包括直接 DB 编辑）。

**实现：** 挂入 ActionExecutor 的 post-action 阶段（EventHandler 分发之后）。

### 4.2 定时评估（轮询）

对 staleness 和 cron 类型的 Watcher，后台 Worker 定时评估条件：

```
WatcherWorker 每分钟运行一次
  → 查找 type='staleness' 或 type='schedule' 的 Watcher
  → 检查是否到了评估时间（cron 匹配或 staleness 间隔）
  → 通过 DataProvider 执行查询
  → 条件满足 → 执行 effect
```

**实现：** 与 OutboxWorker 并行运行。使用同一个 DataProvider 查询。

### 4.3 混合模式（推荐）

两者结合：threshold/set_change 用 Action 后评估；staleness/schedule 用定时评估。

## 5. 去重与防重复

Watcher 不能对同一条件反复触发：

| 策略 | 行为 |
|------|------|
| `once_until_reset` | 条件变为 true 时触发一次。直到条件变为 false 再变为 true 才再次触发。 |
| `once_per_record` | 每条匹配的记录触发一次。追踪已触发的记录 ID。 |
| `cooldown` | 每个 `cooldownPeriod`（如 `'1h'`）最多触发一次。 |

状态追踪存储在系统表：`_linchkit.watcher_state`。

```typescript
// 系统表
_linchkit.watcher_state: {
  watcher_name: string        // Watcher 标识
  group_key: string           // groupBy 值或记录 ID
  last_fired_at: timestamp
  condition_met: boolean      // 当前条件状态
  tenant_id: string
}
```

## 6. WatcherDefinition 完整结构

```typescript
defineWatcher({
  name: string,
  label: string,
  description?: string,

  watch: {
    schema: string,
    filter?: DeclarativeCondition,
    aggregate?: {
      field: string,
      op: 'sum' | 'count' | 'avg' | 'min' | 'max',
      groupBy?: string,        // 按此字段分组
    },
  },

  trigger: {
    type: 'threshold' | 'staleness' | 'schedule' | 'set_change',

    // threshold 类型:
    field?: string,                          // 要比较的字段（单条记录）
    condition?: ComparisonCondition,          // { gt, lt, eq, gte, lte }

    // staleness 类型:
    // field: 要检查的时间戳字段
    // threshold: 时长字符串（'48h', '7d'）

    // schedule 类型:
    cron?: string,
    // condition: 可选 — 仅在条件同时满足时触发

    // set_change 类型:
    on?: 'added' | 'removed' | 'modified',

    // 去重
    debounce?: 'once_until_reset' | 'once_per_record' | 'cooldown',
    cooldownPeriod?: string,     // cooldown 策略的冷却时长
  },

  effect: {
    action: string,
    params: Record<string, unknown> | ((ctx: WatcherContext) => Record<string, unknown>),
  },

  // 限制
  enabled?: boolean,           // 默认: true
  tenantScoped?: boolean,      // 默认: true（按租户评估）
})
```

## 7. 与现有概念的关系

| 概念 | 职责 | 与 Watcher 的区别 |
|------|------|-------------------|
| **Rule** | Action 前置约束 | Rule 阻止/修改特定 Action。Watcher 观察聚合数据状态。 |
| **EventHandler** | 事件后置反应 | Handler 对单个事件做反应。Watcher 对累积数据条件做反应。 |
| **Flow** | 多步骤编排 | Flow 编排序列。Watcher 是单次触发的自动化。 |

**心智模型：**
- Rule = 「这个操作应该被允许吗？」
- EventHandler = 「这个操作发生了，现在做 X」
- Watcher = 「数据已经达到了状态 Y，做 Z」

## 8. 安全

- Watcher effect 通过正常的 Action 管道执行（CommandLayer、权限检查）
- Watcher effect 以 `system` actor 身份运行（不是触发数据变更的用户）
- 每个 Watcher 必须明确授予 system actor 权限
- `tenant_id` 范围是强制的 — Watcher 按租户评估

## 9. 不做什么

- **不在 Action 事务中同步评估 Watcher** — 评估在 Action 之后或定时进行。绝不阻塞 Action 管道。
- **不替代 EventHandler** — Watcher 是补充，不是替代。对特定事件的直接反应用 EventHandler。对聚合/条件驱动的自动化用 Watcher。
- **不构建完整的 CEP（复杂事件处理）引擎** — 保持简单。如果需求超出 threshold/staleness/schedule/set_change，考虑引入专用 CEP 系统。

## 10. 里程碑

### M3
- `defineWatcher()` 类型定义 + `WatcherRegistry`
- 阈值 Watcher（Action 后评估）
- 过期 Watcher（定时评估）
- `_linchkit.watcher_state` 系统表
- 去重: `once_until_reset`、`once_per_record`

### M4
- 集合变更 Watcher
- 定时（cron）Watcher
- Watcher 管理 UI（启用/禁用、查看状态、历史）
- `cooldown` 去重策略

## 11. UI Management

Watcher（响应式自动化）需要管理界面，让管理员配置、监控和审计自动化规则。

### 11.1 自动化规则列表 (`/admin/automations`)

展示所有已注册的 Watcher：

| 列 | 说明 |
|------|------|
| **name** | Watcher 标识 |
| **label** | 人类可读名称 |
| **watch.schema** | 监视的 Schema |
| **trigger.type** | 触发类型（threshold / staleness / schedule / set_change） |
| **effect.action** | 触发的 Action |
| **enabled** | 启用状态（开关控件，支持直接切换） |
| **上次触发** | 最近一次触发的时间 |
| **触发次数** | 累计触发次数（从 `_linchkit.watcher_state` 统计） |

筛选：按 Schema、trigger 类型、启用状态筛选。

### 11.2 Watcher 配置详情

点击 Watcher 进入详情页：

- **监视配置**：watch 的 schema、filter、aggregate 的结构化展示
- **触发条件**：threshold 的条件表达式、staleness 的时间阈值、schedule 的 cron 表达式（附带人类可读说明，如"每周一 9:00"）
- **去重策略**：debounce 模式 + cooldown 参数
- **效果配置**：目标 Action + 参数模板
- **当前状态**：从 `_linchkit.watcher_state` 读取每个 group_key 的当前条件状态和上次触发时间

### 11.3 触发历史 / 执行日志

Watcher 详情页底部展示触发历史：

- 每次触发记录：触发时间、group_key、条件评估结果、执行的 Action、Action 执行结果（成功/失败）
- 支持时间范围筛选
- 失败的触发高亮显示，附带错误信息
- 阈值 Watcher 展示聚合值的历史趋势（简单折线图：值 vs 阈值线）

### 11.4 Watcher 状态监控

在自动化列表页顶部展示整体状态面板：

- **活跃 Watcher 数**：当前启用的 Watcher 总数
- **今日触发数**：当日所有 Watcher 的累计触发次数
- **失败数**：当日触发但 Action 执行失败的次数
- **下次定时评估**：最近一个 schedule/staleness Watcher 的下次评估时间
