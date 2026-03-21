# Rule Engine 与 Flow 设计规范

> 本文说明 Rule Engine 与 Flow 的分工；Rule `execute_action` 的具体使用边界见 `40_rule_execute_action_boundary.md`。

## 1. Rule Engine 内部工作机制

### 1.1 执行流程

```
Action 执行请求
    ↓
1. 根据 trigger 查找匹配的 Rule
   - trigger: { action: 'submit_request' } → 所有监听此 Action 的 Rule
   - 从已注册的 Rule 列表中匹配
    ↓
2. 按优先级排序（priority 高的先评估）
    ↓
3. 分批评估：

   第一批：无 Context 的 Rule（Level 1-2，毫秒级）
    ├── 评估 condition（直接读 target / actor 字段）
    ├── 条件命中 → 收集 effect
    └── 有 block effect → 短路，直接返回失败

   第二批：有 Context 的 Rule（Level 3-5，需要查 DB）
    ├── 获取 Context 数据（查 DB）
    │   └── 相同查询缓存复用（同一次执行内）
    ├── 评估 condition
    ├── 条件命中 → 收集 effect
    └── 有 block effect → 短路
    ↓
4. 合并所有命中 Rule 的 effect：
   - 有 block       → Action 失败，返回所有 block 原因
   - 有 require_approval → Action 挂起，取最高审批级别
   - 有 warn        → 继续执行，返回所有警告
   - 有 enrich      → 修改数据
   - 有 execute_action → 触发后续 Action
   - 有自定义 effect → 调用对应 handler
    ↓
5. 返回评估结果给 Action Engine
```

### 1.2 Rule 注册表

系统启动时，所有 Capability 中定义的 Rule 注册到内存中的 Rule 注册表：

```typescript
interface RuleRegistry {
  byActionTrigger: Map<string, Rule[]>         // action name → rules
  byStateChangeTrigger: Map<string, Rule[]>    // schema.field → rules
  byFieldChangeTrigger: Map<string, Rule[]>    // schema.field → rules
  byEventTrigger: Map<string, Rule[]>          // event type → rules
  byScheduleTrigger: Rule[]                     // cron rules
}
```

### 1.3 声明式 Condition 评估器

```typescript
// 简单条件
{ field: 'target.amount', operator: 'gt', value: 10000 }
→ data.target.amount > 10000

// 组合条件
{ operator: 'and', conditions: [...] }
{ operator: 'or', conditions: [...] }
{ operator: 'not', condition: {...} }

// 字段路径支持点号访问
'target.department.name' → data.target.department.name
```

## 2. Flow（工作流编排）

### 2.1 定位

Flow 是轻量编排器，负责"顺序"和"等待"，不负责"判断"和"合法性"。

```
Flow：编排顺序 — "先做A，再做B，然后等人确认，最后做C"
Rule：裁决 — "能不能做，需不需要审批"
State：真相 — "当前是什么状态，能迁移到哪"
```

### 2.2 编排不只是业务流程

编排贯穿系统所有层面：

| 场景 | 示例 |
|------|------|
| 业务流程 | 采购审批 → 入库 → 付款 |
| AI 任务 | 分析数据 → 生成 Proposal → 验证 → 等人审批 |
| 部署流程 | 构建 → Migration → 启动新实例 → 健康检查 → 切流量 |
| 数据迁移 | introspect → 生成 Schema → 迁移数据 → 验证 |
| Proposal 流程 | 生成代码 → 创建 PR → CI 检查 → 等审批 → 部署 |

### 2.3 技术选型：Temporal

**不自己造编排引擎，使用 Temporal。**

理由：
- 覆盖面最广 — 业务/AI/部署/迁移全能做
- 持久化 — 工作流状态持久存储，进程崩溃后能恢复
- Saga 补偿 — 跨步骤失败时自动执行补偿逻辑
- TS SDK 成熟 — `@temporalio/client` + `@temporalio/worker`
- 可自托管 — 开源，部署在自己服务器
- 可视化 — 自带 Web UI，查看工作流执行状态
- 统一 — 不需要为 AI 编排单独引入 LangGraph

### 2.4 defineFlow = Temporal 的薄封装

开发者用 LinchKit DSL 写流程，框架编译成 Temporal Workflow：

```typescript
import { defineFlow } from '@linchkit/core'

// 开发者写的
export const purchaseApprovalFlow = defineFlow({
  name: 'purchase_approval_flow',
  label: '采购审批流程',
  trigger: { action: 'submit_request' },

  steps: [
    {
      name: 'calculate',
      type: 'action',
      action: 'calculate_total',
    },
    {
      name: 'approval',
      type: 'approval',
      assignee: '$rule.approval_level',
      timeout: '7d',
      onTimeout: 'auto_reject',
    },
    {
      name: 'notify',
      type: 'action',
      action: 'notify_requester',
      async: true,
    },
  ],

  branches: [
    {
      condition: { field: 'amount', operator: 'lte', value: 10000 },
      skipSteps: ['approval'],
    },
  ],
})
```

框架自动编译为 Temporal Workflow，开发者不需要直接写 Temporal 代码。复杂场景也可以直接写 Temporal Workflow。

### 2.5 AI 编排

AI 的多步任务也走 Temporal：

```typescript
export const evolutionFlow = defineFlow({
  name: 'ai_evolution_analysis',
  label: 'AI 进化分析',
  trigger: { schedule: '0 2 * * 1' },  // 每周一凌晨

  steps: [
    {
      name: 'collect_data',
      type: 'action',
      action: 'collect_execution_stats',
    },
    {
      name: 'ai_analyze',
      type: 'ai',
      prompt: '分析执行数据，发现优化机会',
      model: 'claude-sonnet',
      input: '$steps.collect_data.output',
      timeout: '5m',
    },
    {
      name: 'generate_proposals',
      type: 'ai',
      prompt: '根据分析结果生成具体的 Rule/Schema 变更建议',
      input: '$steps.ai_analyze.output',
    },
    {
      name: 'create_proposals',
      type: 'action',
      action: 'create_proposal',
      input: '$steps.generate_proposals.output',
      forEach: true,
    },
  ],
})
```

### 2.6 Step 类型

| 类型 | 说明 |
|------|------|
| `action` | 执行 LinchKit Action |
| `approval` | 等待人工审批 |
| `wait` | 等待事件或条件 |
| `ai` | 调用 LLM（带 prompt、model、timeout） |
| `branch` | 条件分支 |
| `parallel` | 并行执行多个步骤 |
| `subprocess` | 调用另一个 Flow |

## 3. 三者分工

| 引擎 | 适用场景 | 实现 |
|------|---------|------|
| **Action Engine** | 单步操作，不需要等待或编排 | 自研 |
| **Temporal** | 多步骤、有等待、有分支、需要持久化 | 集成 |
| **Outbox Worker** | 事件触发的轻量异步任务（通知、索引） | 自研 |

判断标准：
- 一步能完成 → Action Engine
- 需要等人/等事件/多步串联 → Temporal
- 事件触发的即发即忘任务 → Outbox

## 4. Flow 不负责的事

- ❌ 判断"能不能做"（Rule 负责）
- ❌ 判断"状态合不合法"（State Machine 负责）
- ❌ 业务逻辑计算（Action handler 负责）
- ❌ 数据校验（Action validate 负责）

## 5. 与里程碑的关系

### M0
- 不引入 Temporal
- Action 直接执行（单步）
- Outbox 处理异步任务
- 简单审批用 Rule 的 require_approval（无 Flow）

### M1
- 引入 Temporal
- defineFlow 基础实现（顺序步骤 + 审批 + 超时）
- 部署流程用 Temporal 编排

### M2
- Flow 的 AI 步骤（type: 'ai'）
- 条件分支、并行步骤
- Proposal 流程用 Temporal 编排
- AI 进化分析流程

### M3
- 复杂业务流程
- 跨 Capability 编排
- Saga 补偿模式
