# Rule 设计规范

> 本文定义 Rule 模型；Rule 在统一执行链中的时序见 `39_execution_contract.md`，`execute_action` 的使用边界见 `40_rule_execute_action_boundary.md`。

## 1. 定位

Rule 是系统的业务规则层。它监听系统事件（Action 执行、状态变更、字段变更等），在执行前或执行中做判断，决定允许、阻止、警告或要求审批。

**Rule 不是散落在代码里的 if/else，而是独立的、可管理的、事件驱动的裁决器。**

## 2. 核心结构

```
Rule = Trigger + Context(可选) + Condition + Effect
```

- **Trigger** — 什么时候触发
- **Context** — 执行前收集什么数据（可选，Level 3+ 才需要）
- **Condition** — 基于数据做什么判断
- **Effect** — 判断成立后做什么

## 3. 声明式 vs 代码式

与 Action 相同，Rule 也分两种：

### 3.1 声明式 Rule

Condition 用声明式表达式（JSON 格式），AI 可直接生成和理解。定义在 TS 文件中，通过 Proposal → 蓝绿部署生效。

```typescript
import { defineRule } from '@linchkit/core'

// 简单条件
export const amountCheck = defineRule({
  name: 'amount_check',
  label: '大额采购需审批',
  trigger: { action: 'submit_request' },

  condition: {
    field: 'target.amount',
    operator: 'gt',
    value: 10000,
  },

  effect: {
    type: 'require_approval',
    level: 'director',
    message: '采购金额超过10000，需要总监审批',
  },
})

// 组合条件（and / or / not）
export const combinedCheck = defineRule({
  name: 'combined_check',
  label: '销售部大额需总监审批',
  trigger: { action: 'submit_request' },

  condition: {
    operator: 'and',
    conditions: [
      { field: 'target.amount', operator: 'gt', value: 10000 },
      { field: 'target.department.name', operator: 'eq', value: '销售部' },
    ],
  },

  effect: {
    type: 'require_approval',
    level: 'director',
  },
})
```

### 3.2 代码式 Rule — 需要部署

复杂到声明式无法表达的逻辑。

```typescript
export const complexCheck = defineRule({
  name: 'complex_check',
  label: '复杂业务规则',
  trigger: { action: 'submit_request' },

  condition: ({ target, context, actor }) => {
    // 任意复杂逻辑
    return someComplexCalculation(target, context)
  },

  effect: { type: 'block', message: '不满足条件' },
})
```

### 3.3 变更方式

所有 Rule 变更（声明式和代码式）走统一路径：
- 修改 TS 文件 → 构建 → 蓝绿部署
- Source of truth 始终是 TS 文件 / Git

声明式和代码式的区分仍然有意义，但不是为了"能否热更新"，而是：
- **声明式** — AI 可以直接生成和理解，条件表达式可序列化
- **代码式** — 处理声明式无法表达的复杂逻辑

## 4. 声明式条件运算符

| 运算符 | 说明 | 示例 |
|--------|------|------|
| `eq` | 等于 | `{ field: 'status', operator: 'eq', value: 'draft' }` |
| `neq` | 不等于 | |
| `gt` | 大于 | |
| `gte` | 大于等于 | |
| `lt` | 小于 | |
| `lte` | 小于等于 | |
| `in` | 在列表中 | `{ field: 'status', operator: 'in', value: ['draft', 'submitted'] }` |
| `not_in` | 不在列表中 | |
| `is_null` | 为空 | |
| `not_null` | 不为空 | |
| `contains` | 包含（字符串/数组） | |
| `and` | 逻辑与（组合） | |
| `or` | 逻辑或（组合） | |
| `not` | 逻辑非（组合） | |

## 4a. DeclarativeCondition as Unified Filter DSL

The `DeclarativeCondition` type defined in `@linchkit/core/types/rule.ts` is the **unified filter format** shared across the entire system:

| Subsystem | Usage |
|-----------|-------|
| **Rule conditions** | `rule.condition` — evaluate whether a rule applies |
| **View filters** | Lens Filter output, saved view configs, defaultFilter |
| **GraphQL queries** | `filter` parameter in list queries |
| **State Ribbon** | Click a state → generates `{ field, operator: "eq", value }` |
| **Saved Views** | Persisted as serialized DeclarativeCondition arrays |

Additional operators beyond the core set (for View/search use cases):

| Operator | Description | Example |
|----------|-------------|---------|
| `between` | Range (inclusive) | `{ field: 'amount', operator: 'between', value: [1000, 5000] }` |
| `startsWith` | String prefix match | `{ field: 'title', operator: 'startsWith', value: 'PR-' }` |
| `endsWith` | String suffix match | |
| `notContains` | String does not contain | |

This format is JSON-serializable, AI-friendly (LLMs can generate/parse it), and evaluated by `condition-evaluator.ts` on both client and server.

## 5. Trigger 类型

```typescript
// Action 触发 — 某个 Action 执行时
trigger: { action: 'submit_request' }

// 多个 Action 触发
trigger: { action: ['submit_request', 'update_request'] }

// 状态变更触发
trigger: { stateChange: { schema: 'purchase_request', to: 'approved' } }
trigger: { stateChange: { schema: 'purchase_request', from: 'draft', to: 'submitted' } }

// 字段变更触发
trigger: { fieldChange: { schema: 'purchase_request', field: 'amount' } }

// 事件触发
trigger: { event: 'inventory.stock_below_threshold' }

// 定时触发
trigger: { schedule: '0 9 * * 1' }  // cron 表达式
```

## 6. Context（数据收集）

Context 在 condition 评估前收集需要的数据。没有 Context 的 Rule 只能访问 target（当前记录）和 actor（当前操作者）。

### 分阶段实现

**M0 — 无 Context（Level 1-2）**
只能判断当前记录的字段和 actor 信息。

**M1 — 简单 Context（Level 3）**
可以查同模块的关联数据。

**M2+ — 完整 Context（Level 4-5）**
支持聚合查询和跨模块查询。

### Context 查询结构（M1+ 实现）

```typescript
context: {
  monthlyTotal: {
    query: 'purchase_request',
    filter: {
      department: '$target.department',
      status: { in: ['submitted', 'approved', 'purchased'] },
      request_date: { gte: '$month_start' },
    },
    aggregate: { sum: 'amount' },
  },

  // 跨模块查询（M2+）
  urgentProjects: {
    query: 'project_management.project',  // capability.schema
    filter: {
      assignee: '$actor.id',
      priority: 'urgent',
      deadline: { lte: '$now + 7d' },
    },
  },
}
```

Context 中的特殊变量：
- `$target` — 当前操作的记录
- `$actor` — 当前操作者
- `$now` — 当前时间
- `$month_start` — 当月第一天
- `$year_start` — 当年第一天

## 7. Effect 类型

| Effect | 说明 | 备注 |
|--------|------|------|
| `block` | 阻止操作 | 最高优先级，Action 直接失败 |
| `warn` | 允许但警告 | 累积，全部返回给调用方 |
| `require_approval` | 需要审批 | 多个取最高级别，详见 35_approval_mechanism.md |
| `enrich` | 自动补充/修改数据 | 全部执行，修改 Action 的输入数据 |
| `execute_action` | 触发另一个 Action | 全部执行，但必须受限使用，详见 `40_rule_execute_action_boundary.md` |

### Effect 执行时序

所有 Effect 在 **Action 主逻辑执行前** 评估和生效（在 Action 13 步流程的 Step 5）：

- `block` → Action 立即终止，不开事务
- `require_approval` → Action 挂起，创建审批请求，不开事务（详见 35_approval_mechanism.md）
- `warn` → 记录警告，继续执行
- `enrich` → 修改 Action 的输入数据（在事务开始前），后续步骤使用修改后的数据
- `execute_action` → 在主 Action 开事务前触发关联 Action。关联 Action 有自己独立的事务。默认失败即中断，且必须做循环检测、深度限制和数量限制。详见 `40_rule_execute_action_boundary.md`

**`execute_action` vs EventHandler 的区别**：
- Rule `execute_action`：在主 Action 执行**前**触发，是前置联动
- EventHandler：在主 Action 执行**后**触发，是后置联动
- 如果关联动作依赖主 Action 的结果，应该用 EventHandler 而非 Rule `execute_action`
- 如果联动超过轻量前置动作的范围，应该改用 Flow / Restate，而不是继续堆 Rule `execute_action`

### Effect 完整结构

```typescript
effect: {
  type: 'block',
  message: '不允许操作',        // 人类可读
  reason: 'amount_exceeded',    // 机器可读
}

effect: {
  type: 'require_approval',
  level: 'director',            // 审批级别
  message: '需要总监审批',
}

effect: {
  type: 'enrich',
  setFields: {
    risk_level: 'high',
    requires_review: true,
  },
}

effect: {
  type: 'execute_action',
  action: 'send_notification',
  params: { to: '$target.requester', template: 'request_blocked' },
}
```

## 8. 多 Rule 合并策略

同一个 Trigger 可能匹配多条 Rule，合并策略：

```
1. 收集所有匹配的 Rule
2. 按优先级排序（priority 字段，默认 0）
3. 无 Context 的 Rule 先评估（快）
4. 有 Context 的 Rule 后评估（慢，且可能被短路）
5. 合并所有命中 Rule 的 Effect：
   - 有任何 block → 直接拦截，收集所有 block 原因返回
   - 无 block 但有 require_approval → 取最高级别
   - warn 全部收集返回
   - enrich 全部执行
   - execute_action 全部执行
```

Rule 可以声明 `priority`：
```typescript
defineRule({
  name: 'critical_check',
  priority: 100,  // 数字越大越先评估，block 后可短路后续 Rule
  // ...
})
```

## 9. 性能优化

- Context 查询结果在同一次 Action 执行中缓存 — 多条 Rule 查同一数据只查一次
- 无 Context 的 Rule 先执行 — 如果已经 block，有 Context 的 Rule 不用再查数据
- 高优先级 Rule 先执行 — 可以提前短路

## 10. 与 Bridge 的关系

Bridge 模块可以：
- 新增 Rule（给已有 Action 加规则）
- 覆盖已有 Rule 的 condition / effect / trigger
- 禁用已有 Rule

```typescript
import { overrideRule, disableRule } from '@linchkit/core'

export const ovr = overrideRule('amount_check', {
  condition: { field: 'target.amount', operator: 'gt', value: 50000 },
})

export const dis = disableRule('some_rule_name')
```

## 11. UI Management

Rule 需要独立的管理界面，让系统管理员和业务管理员可以查看、理解和审计所有业务规则。

### 11.1 Rule 列表页 (`/admin/rules`)

展示所有已注册的 Rule，支持以下能力：

| 功能 | 说明 |
|------|------|
| **按 Schema 筛选** | 只看某个 Schema 相关的 Rule |
| **按 Trigger 类型筛选** | action / stateChange / fieldChange / event / schedule |
| **按 Effect 类型筛选** | block / warn / require_approval / enrich / execute_action |
| **按启用状态筛选** | 已启用 / 已禁用（被 `disableRule` 覆盖的） |
| **按来源筛选** | 原始 Capability / Bridge 覆盖 / Bridge 新增 |
| **搜索** | 按 Rule name / label 搜索 |

列表列：name、label、trigger 摘要、effect 类型、priority、来源 Capability、启用状态。

### 11.2 Rule 详情视图

点击 Rule 进入详情页，展示完整定义：

- **Trigger 区**：触发条件的可视化展示（Action 名称、状态变更路径、事件类型等）
- **Condition 可视化**：声明式条件渲染为树形表达式（and/or/not 分支 + 叶子条件卡片）。代码式条件显示函数签名 + 源码位置
- **Effect 区**：效果类型 + 参数（message、level、setFields 等）
- **Context 区**（如有）：数据查询的结构化展示
- **Override 链**：如果被 Bridge `overrideRule` 覆盖，展示覆盖前后的对比 diff

### 11.3 Rule 执行历史

每条 Rule 详情页底部包含执行历史 Tab：

- 从 `_linchkit_executions` 表中筛选包含该 Rule 评估结果的执行记录
- 展示：触发时间、触发 Action、评估结果（命中/未命中）、Effect 执行结果
- 支持按时间范围筛选
- 高频命中的 Rule 标记为"活跃"，长期未命中的标记为"休眠"

### 11.4 AI 建议规则集成

在 Rule 列表页和 Schema 详情页中，展示 AI 建议的规则：

- AI 通过 evolver Agent 分析执行数据后生成的 Rule Proposal
- 以"建议卡片"形式展示（区别于已生效的 Rule）
- 用户可以点击"查看详情" → 跳转到 Proposal 审批流程
- 标注建议原因（如"检测到 X 模式，建议添加 Y 规则"）
