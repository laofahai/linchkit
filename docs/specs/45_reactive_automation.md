# 数据条件 Watcher

> Status: Partial | Date: 2026-05-08
> 灵感来源: Palantir Automate（对象集条件触发、阈值越界）
> 里程碑: M5
> Issue: #150（移除 AutomationEngine，spec 仅保留 Watcher）

## 1. 为什么需要 Watcher

LinchKit 的事件反应能力由 `defineEventHandler` 提供：当 Action 成功、记录变更、状态迁移等**系统事件**发生时，处理器同步或异步地执行副作用。EventHandler 解决「事件 X 发生 → 做 Y」。

但还存在一类反应不能用事件表达 —— **数据自身达到某种状态**：

- 「当某部门待审批的采购申请总额超过 ¥100,000 时，通知 CFO」（聚合越界）
- 「当库存数量低于安全库存时，自动创建采购申请」（单字段越界）
- 「当申请在 submitted 状态停留超过 48 小时时，升级处理」（时间维度的"停滞"）
- 「当一条记录新进入或离开某个过滤集合时，发送通知」（集合成员变化）

这些条件**不是单个事件**，而是数据的累积状态、时间维度的停滞、或集合层面的入/出。EventHandler 看不到「累积」「停滞」或「集合差」—— 它只看到一个个独立事件。

`defineWatcher` 提供与 EventHandler 互补的能力：**声明数据条件，由 WatcherEngine 在合适的时机评估并通过 CommandLayer 触发 Action**。

> **不是 EventHandler 的替代**。事件直接反应仍然用 `defineEventHandler`；Watcher 只针对数据条件型自动化。两者机制和心智模型都不同（详见 §6）。

## 2. 四种触发类型

Watcher 共定义四种触发器。前三种已实现并配套测试，`schedule` 已定义类型但**尚未实现**。

| trigger.type | 何时触发 | 评估方式 | 实现状态 |
|--------------|---------|---------|---------|
| `threshold` | 字段或聚合值越过比较条件 | Action 后（事件总线） | ✅ 已实现 |
| `set_change` | 记录进入/离开过滤集合，或在集合内被更新 | Action 后（事件总线） | ✅ 已实现 |
| `staleness` | 记录在某状态停留超过阈值 | 后台定时轮询 | ✅ 已实现 |
| `schedule` | 按 cron 表达式定时评估 | （后台定时轮询） | ⚠️ 类型已定义，引擎未实现 |

> `watch.filter` 的类型是 `DeclarativeCondition`（`{ field, operator, value }` / 复合 `and`/`or` / `not`），与 Rule 共享。后续示例都使用这一形式。

### 2.1 threshold — 阈值越界

`threshold` 监视单条记录的某个字段，或一组记录的聚合值（sum / count / avg / min / max），当值满足比较条件（`gt` / `gte` / `lt` / `lte` / `eq`）时触发。

聚合时 `aggregate.field` 必须是数值字段：当前 `computeAggregate()` 先把 `field` 的值过滤到数值，再做 `sum`/`avg`/`min`/`max`/`count` —— 因此 **`count` 等于「`aggregate.field` 是数值的记录数」，不是「过滤后所有记录数」**。`groupBy` 当前**仅用于 debounce 的分组 key**（控制每个 group 只触发一次），并**不会**让引擎按组计算多份聚合 —— 引擎对 `watch.filter` 过滤后的全集计算单一聚合值。

```typescript
// 单条记录字段
defineWatcher({
  name: 'low_inventory_alert',
  watch: { entity: 'inventory_item' },
  trigger: { type: 'threshold', field: 'quantity', condition: { lt: 10 }, debounce: 'once_until_reset' },
  effect: { action: 'create_purchase_request', params: (ctx) => ({ item_id: ctx.record!.id }) },
})

// 全集聚合（pending 申请总额超过 ¥100,000）
defineWatcher({
  name: 'pending_budget_alert',
  watch: {
    entity: 'purchase_request',
    filter: {
      operator: 'or',
      conditions: [
        { field: 'status', operator: 'eq', value: 'submitted' },
        { field: 'status', operator: 'eq', value: 'approved' },
      ],
    },
    aggregate: { field: 'amount', op: 'sum' },
  },
  trigger: { type: 'threshold', condition: { gt: 100_000 }, debounce: 'once_until_reset' },
  effect: { action: 'send_notification', params: (ctx) => ({ template: 'budget_exceeded', value: ctx.value }) },
})
```

### 2.2 set_change — 集合成员变化

`set_change` 监视过滤集合的成员变化。比较记录变更前后是否匹配 `watch.filter`：
- `on: 'added'` — 之前不匹配，现在匹配（新进入集合）
- `on: 'removed'` — 之前匹配，现在不匹配（离开集合）
- `on: 'modified'` — 变更前后**都仍在集合内**，且本次确实是 update（`oldRecord` 存在）。引擎**不**做新旧字段值的内容比较，只要在集合内被更新过就 fire。

```typescript
defineWatcher({
  name: 'new_high_value_request',
  watch: {
    entity: 'purchase_request',
    filter: {
      operator: 'and',
      conditions: [
        { field: 'amount', operator: 'gt', value: 50_000 },
        { field: 'status', operator: 'eq', value: 'submitted' },
      ],
    },
  },
  trigger: { type: 'set_change', on: 'added' },
  effect: { action: 'send_notification', params: (ctx) => ({ to: 'cfo@company.com', id: ctx.record!.id }) },
})
```

### 2.3 staleness — 停滞越界

`staleness` 在后台定时检查匹配记录的时间戳字段，超过阈值视为停滞，触发效果。

```typescript
defineWatcher({
  name: 'stale_request_escalation',
  watch: {
    entity: 'purchase_request',
    filter: { field: 'status', operator: 'eq', value: 'submitted' },
  },
  trigger: { type: 'staleness', field: 'updated_at', threshold: '48h' },
  effect: { action: 'escalate_request', params: (ctx) => ({ id: ctx.record!.id }) },
})
```

支持的时长单位：`d` / `h` / `m` / `s`（如 `'48h'`、`'7d'`、`'30m'`）。

### 2.4 schedule — 定时（specified, not yet implemented）

`schedule` 计划按 cron 表达式定时评估条件。**类型已在 `WatcherTrigger` 中定义，但 WatcherEngine 中尚无 cron 调度实现**。声明此类 Watcher 当前不会执行。

```typescript
// 类型已定义，引擎实现待补
defineWatcher({
  name: 'weekly_unapproved_digest',
  watch: {
    entity: 'purchase_request',
    filter: { field: 'status', operator: 'eq', value: 'submitted' },
    aggregate: { field: 'amount', op: 'count' },
  },
  trigger: { type: 'schedule', cron: '0 9 * * 1', condition: { gt: 0 } },
  effect: { action: 'send_digest', params: () => ({}) },
})
```

## 3. `defineWatcher()` API

```typescript
import { defineWatcher } from '@linchkit/core'
import type { WatcherDefinition } from '@linchkit/core'

export function defineWatcher(
  definition: Omit<WatcherDefinition, 'enabled'> & { enabled?: boolean },
): WatcherDefinition
```

`WatcherDefinition` 完整结构：

```typescript
interface WatcherDefinition {
  name: string                 // 唯一标识
  label?: string
  description?: string
  watch: {
    entity: string             // 目标实体
    filter?: DeclarativeCondition
    aggregate?: { field: string; op: 'sum' | 'count' | 'avg' | 'min' | 'max'; groupBy?: string }
  }
  trigger: ThresholdWatcherTrigger | StalenessWatcherTrigger | ScheduleWatcherTrigger | SetChangeWatcherTrigger
  effect: {
    action: string             // 通过 CommandLayer 执行的 Action 名
    params: Record<string, unknown> | ((ctx: WatcherContext) => Record<string, unknown>)
  }
  enabled: boolean             // 默认 true
  tenantScoped?: boolean       // 默认 true
}
```

每种 trigger 都支持 `debounce`：

- `'once_until_reset'` — 同一个 group key 内，条件再次满足时**不会**自动 re-fire；
  - 对 **`staleness`**：当 staleness 检查发现条件不再满足时，引擎会把 `conditionMet` 自动清回 `false`，下次再次满足时可重新触发。
  - 对 **`threshold` / `set_change`**：状态只会被 fire 时设为 `true`，不再回滚。后续若需 re-fire，必须显式调用 `WatcherEngine.resetState(name, groupKey)`（或进程重启，因 stateMap 在内存中）。
- `'once_per_record'` — 按 group key 仅触发一次，永久停留。
- `'cooldown'` + `cooldownPeriod` — 上次 fire 后经过指定间隔才允许再次 fire（默认 `1h`）。

完整定义见 `packages/core/src/types/watcher.ts`。

## 4. WatcherEngine

WatcherEngine 是 `Watcher` 生命周期合约（`packages/core/src/life-system/watcher.ts`）的具体实现，按 Spec 56 移出 core，落在 `@linchkit/cap-ai-provider`：

- **注册查找** —— `WatcherRegistry`（`packages/core/src/automation/watcher-registry.ts`）按 entity 索引，post-mutation 时只评估相关 Watcher。
- **响应式评估** —— 订阅 EventBus 上的 `record.created` / `record.updated`；对 `threshold` 和 `set_change` 触发器，事件到达后立即评估并按 debounce 决定是否 fire。
- **轮询评估** —— `staleness` 触发器由 `setInterval`（默认 60s）周期性检查 `dataQuerier.queryRecords()` 的结果。`schedule` 触发器尚未接入轮询（见 §2.4）。
- **效果执行** —— 通过注入的 `WatcherActionExecutor.executeAction(name, input)` 调用。引擎本身**不感知 CommandLayer**；cap-ai-provider 在装配时把 executor 桥接到 CommandLayer，使 Watcher fire 与普通 Action 共享 7-slot 管线（auth / permission / tenant / pre-action / post-action）。其他 executor 实现（测试桩、低权限沙盒）也可以接入此接口。
- **debounce 状态** —— 当前为内存中的 `stateMap`（`${watcherName}:${groupKey}`）。**持久化的 `_linchkit.watcher_state` 系统表尚未实现**，进程重启会丢失 debounce 状态。

详见实现：`addons/ai-provider/cap-ai-provider/src/watcher-engine.ts`，测试：`addons/ai-provider/cap-ai-provider/__tests__/watcher-engine.test.ts`。

## 5. 示例

### 5.1 库存低于阈值自动补货

```typescript
defineWatcher({
  name: 'inventory_replenish',
  label: '库存补货',
  watch: { entity: 'inventory_item' },
  trigger: {
    type: 'threshold',
    field: 'quantity',
    condition: { lt: 10 },
    debounce: 'cooldown',
    cooldownPeriod: '24h',
  },
  effect: {
    action: 'create_purchase_request',
    params: (ctx) => ({ item_id: ctx.record!.id, quantity: ctx.record!.reorder_quantity }),
  },
})
```

效果：当 `inventory_item.quantity` 跌破 10 时触发一次 `create_purchase_request`；同一记录的下一次触发受 24h 冷却限制（`cooldown`），避免补货中途的多次写入引起重复采购。
若改用 `'once_until_reset'`，则触发一次后状态会一直停留在「已触发」，直到调用 `WatcherEngine.resetState(...)` 或进程重启 —— 适合「永久封存到首次告警结束」的场景，不适合自动恢复。

### 5.2 大额申请进入待审队列时通知 CFO

```typescript
defineWatcher({
  name: 'high_value_request_alert',
  watch: {
    entity: 'purchase_request',
    filter: {
      operator: 'and',
      conditions: [
        { field: 'amount', operator: 'gt', value: 50_000 },
        { field: 'status', operator: 'eq', value: 'submitted' },
      ],
    },
  },
  trigger: { type: 'set_change', on: 'added' },
  effect: {
    action: 'send_notification',
    params: (ctx) => ({ to: 'cfo@company.com', subject: 'High-value request', request_id: ctx.record!.id }),
  },
})
```

效果：仅当一条记录从「不匹配 filter」变成「匹配 filter」时通知 CFO（避免对已经在队列里的旧记录重复发）。

### 5.3 长期未处理的提交自动升级

```typescript
defineWatcher({
  name: 'submitted_too_long',
  watch: {
    entity: 'purchase_request',
    filter: { field: 'status', operator: 'eq', value: 'submitted' },
  },
  trigger: { type: 'staleness', field: 'updated_at', threshold: '48h', debounce: 'once_per_record' },
  effect: { action: 'escalate_request', params: (ctx) => ({ id: ctx.record!.id }) },
})
```

效果：每条 `submitted` 状态超过 48 小时未更新的记录会被升级一次。

## 6. 与其他元模型概念的关系

| 概念 | 触发依据 | 与 Watcher 的关系 |
|------|---------|-------------------|
| **Rule** | Action 前置约束 | Rule 阻止/修改特定 Action 的执行。Watcher 不参与 Action 准入。 |
| **EventHandler** | 系统事件（Action 成功、状态迁移、记录变更） | Handler 对**单个事件**反应。Watcher 对**累积/聚合/集合/停滞**反应。 |
| **Flow** | 显式编排多步 | Flow 编排过程。Watcher 是单触发→单 Action。 |

**心智模型：**
- Rule = 「这个操作应该被允许吗？」
- EventHandler = 「事件 X 发生了，做 Y」
- Watcher = 「数据/集合/时间已经达到了状态 Z，做 W」

## 7. UI 管理

Watcher 管理界面（`/admin/automations`，规划中，尚未实装）。规划展示：

- **列表**：name / label / watch.entity / trigger.type / effect.action / enabled / 上次触发时间 / 累计触发次数。
- **详情**：watch / trigger / debounce 的结构化展示；从 `watcher_state` 读取每个 group key 的当前条件状态。
- **历史**：触发时间、group key、condition 评估结果、Action 执行结果（成功/失败）；阈值类 Watcher 展示聚合值随时间的折线图。
- **状态面板**：活跃 Watcher 数 / 当日触发数 / 失败数 / 下次定时评估时间。

实装依赖 `_linchkit.watcher_state` 表（§4 中尚未持久化）和 cap-ai-provider 暴露的查询接口。

## 8. 不做什么 / 已移除

- **AutomationEngine / `defineAutomation` / AutomationTrigger / AutomationAction —— 已在 PR #146 移除。** 它们与 EventHandler 形成声明式重复，没有独立价值。系统事件反应统一使用 `defineEventHandler`，数据条件反应使用 `defineWatcher`。
- **不在 Action 事务中同步评估 Watcher** —— Watcher fire 在 post-action 之后或后台轮询中进行，绝不阻塞 Action 主路径。
- **不替代 EventHandler** —— Watcher 是补充。直接事件反应（如「Action 成功后写审计日志」）继续用 EventHandler。
- **不构建完整的 CEP（复杂事件处理）引擎** —— 当前覆盖 threshold / staleness / set_change / schedule 四种条件，超出此范围的复杂时序逻辑应外接专用 CEP 系统。

## 9. 里程碑

### 已完成（M3）

- `defineWatcher()` + `WatcherDefinition` 类型
- `WatcherRegistry`（注册、enable/disable、按 entity 查找）
- WatcherEngine 实装（`@linchkit/cap-ai-provider`）：threshold（单条 + 聚合）、set_change、staleness
- 三种 debounce 策略：`once_until_reset` / `once_per_record` / `cooldown`
- EventBus 订阅、CommandLayer 接入

### 待完成（M5+）

- `schedule` 触发器引擎实现（cron 调度）
- `_linchkit.watcher_state` 系统表持久化（替换内存 stateMap）
- `aggregate.groupBy` 真正按分组计算多份聚合（当前只把 `groupBy` 用作 debounce key）
- `set_change` 的 `'modified'` 增加新旧字段值比较（当前只校验 in-set 状态）
- `/admin/automations` 管理 UI + 触发历史 + 聚合趋势
