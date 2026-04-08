# Action 设计规范

> Tracking milestones:
> - foundational meta-model reference
>
> Related issues:
> - GitHub Issue `#78` — AI deep integration: NL intent resolution
> - No dedicated open issue is currently tracked for the rest of this spec.
>
> Execution source of truth: GitHub milestones and issues.

> 本文定义 Action 结构；Action 与 Rule / Approval / Event / Execution / Error 的统一执行时序见 `39_execution_contract.md`。

## 1. 定位

Action 是系统的**唯一写入口**。UI / API / AI 都通过 Action 改变系统状态。

Action 不是 CRUD，而是有业务语义的受控执行单元：
- ✅ `submit_request`、`approve_request`、`cancel_order`
- ❌ `updatePurchaseRequest`、`setStatus`、`insertRow`

## 2. 两种 Action

### 2.1 声明式 Action

不需要写代码，框架根据声明自动执行。适合简单操作（状态变更、基础校验等）。

```typescript
import { defineAction } from '@linchkit/core'

export const submitRequest = defineAction({
  name: 'submit_request',
  schema: 'purchase_request',
  label: '提交采购申请',

  input: {
    id: { type: 'ref', target: 'purchase_request', required: true },
  },

  validate: {
    required: ['title', 'amount', 'department'],
  },

  stateTransition: { from: 'draft', to: 'submitted' },

  policy: {
    mode: 'sync',
    transaction: true,
    idempotent: true,
  },
})
```

### 2.2 代码式 Action

需要写 handler，适合复杂业务逻辑。

```typescript
export const calculateTotal = defineAction({
  name: 'calculate_total',
  schema: 'purchase_request',
  label: '计算采购总额',

  input: {
    id: { type: 'ref', target: 'purchase_request', required: true },
  },

  policy: {
    mode: 'sync',
    transaction: true,
  },

  handler: async (ctx) => {
    const items = await ctx.query('purchase_item', { request_id: ctx.input.id })
    const total = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)
    await ctx.update('purchase_request', ctx.input.id, { amount: total })
  },
})
```

## 3. Action 完整结构

```typescript
defineAction({
  // --- 基本信息 ---
  name: string,             // 唯一标识
  schema: string,           // 所属 Schema（主操作对象）
  label: string,            // 人类可读名称
  description?: string,     // 详细说明（AI 可读）

  // --- 输入定义 ---
  input: {
    [key: string]: FieldDefinition,  // 和 Schema field 同样的类型系统
  },

  // --- 输出定义 ---
  output?: {
    [key: string]: FieldDefinition,
  },

  // --- 前置校验（声明式） ---
  validate?: {
    required?: string[],             // 目标记录的必填字段
    custom?: (ctx) => ValidationResult,  // 自定义校验逻辑
  },

  // --- 状态迁移（声明式） ---
  stateTransition?: {
    from: string | string[],  // 允许的源状态（可多个）
    to: string,               // 目标状态
  },

  // --- 字段更新（声明式） ---
  setFields?: {
    [field: string]: any,     // 固定值或表达式
  },

  // --- 执行逻辑（代码式） ---
  handler?: (ctx: ActionContext) => Promise<any>,

  // --- 执行策略 ---
  policy: {
    mode: 'sync' | 'async',           // 同步或异步
    transaction: boolean,               // 是否需要事务
    idempotent?: boolean,               // 是否幂等
    failurePolicy?: 'fail' | 'retry' | 'compensate',  // 失败策略
    retryConfig?: {                     // 重试配置（async 时）
      maxRetries: number,
      backoff: 'fixed' | 'exponential',
    },
  },

  // --- 资源限制（类 Salesforce Governor Limits）---
  limits?: {
    maxExecutionTime?: number,         // 最大执行时间（ms），默认 30000
    maxDbOperations?: number,          // 最大数据库操作数，默认 100
    maxEvents?: number,                // 最大事件发射数，默认 50
    maxChildActions?: number,          // 最大子 Action 调用数，默认 10
  },
  // 框架在 ActionContext 中自动计量，超限抛 SystemError
  // 不同租户 tier 可配置不同限制（SaaS 模式）

  // --- 副作用声明 ---
  sideEffects?: Array<{
    type: 'state_change' | 'create' | 'update' | 'delete' | 'execute_action' | 'emit_event',
    target: string,
    description?: string,
  }>,

  // --- 接口暴露控制 ---
  exposure?: {
    http?: boolean,       // HTTP API 可调（默认 true）
    mcp?: boolean,        // MCP / AI 可调（默认 true）
    cli?: boolean,        // CLI 可调（默认 true）
    ui?: boolean,         // UI 可调（默认 true）
    internal?: boolean,   // ctx.execute 可调（默认 true）
  } | 'all',              // 'all' = 全部开放（默认）

  // --- 权限 ---
  permissions?: {
    roles?: string[],         // 允许的角色
    actorTypes?: ActorType[], // 允许的 actor 类型（human / ai / system 等）
  },
})
```

## 4. ActionContext（ctx）

handler 中通过 ctx 操作系统，不直接碰数据库。

```typescript
interface ActionContext {
  // 输入
  input: Record<string, any>

  // 当前 actor
  actor: {
    type: 'human' | 'ai' | 'system' | 'worker' | 'timer'
    id: string
    roles: string[]
  }

  // 数据操作（框架自动管事务、记事件、做权限检查）
  get(schema: string, id: string): Promise<Record>
  query(schema: string, filter: object): Promise<Record[]>
  create(schema: string, data: object): Promise<Record>
  update(schema: string, id: string, data: object): Promise<Record>
  delete(schema: string, id: string): Promise<void>

  // 触发其他 Action
  execute(actionName: string, input: object): Promise<any>

  // 发自定义事件（框架事件自动发，不需要手动）
  emit(eventType: string, payload: object): void

  // 当前执行信息
  executionId: string
  timestamp: Date
}
```

## 5. Action 执行流程

所有 Action 调用通过统一 Command Layer 进入（CLI / MCP / HTTP API / UI 共享同一入口，详见 16_command_layer_and_api.md）。

一个 Action 从调用到完成经过以下步骤：

```
1. Command Layer 接收请求（来自 CLI / MCP / API / UI）
   ↓
2. 接口暴露检查 — 这个 Action 允许当前接口调用吗？（exposure）
   ↓
3. 身份验证 — 谁在调用？（Actor）
   ↓
4. 权限检查 — 这个 Actor 有权限执行此 Action 吗？（permission）
   ↓
5. 输入校验 — input 是否合法？（基于 Zod 生成的校验）
   ↓
6. 前置校验 — validate 中定义的业务校验
   ↓
7. Rule 评估 — 触发 action trigger 的 Rule（可能 block / warn / require_approval）
   ↓
8. 开始事务
   ↓
9. State 检查 — 如果有 stateTransition，检查当前状态是否允许迁移
   ↓
10. 执行
    - 声明式：框架自动执行 setFields + stateTransition
    - 代码式：调用 handler(ctx)（受 systemPermissions 约束）
   ↓
11. State 迁移 — 更新状态
   ↓
12. 记录 Event — action.succeeded / state.transition 等
   ↓
13. 记录 Execution Log
   ↓
14. 提交事务
   ↓
15. 事务后处理 — 异步副作用（通知、索引更新等）
```

## 6. Action 粒度原则

拆分 Action 的维度：

1. **业务动作语义** — 一个 Action 对应一个业务动作
2. **风险边界** — 高风险操作单独一个 Action，方便加 Rule 控制
3. **规则边界** — 需要不同 Rule 的操作拆开
4. **状态迁移边界** — 不同的状态迁移拆成不同 Action

## 7. 与 Bridge 的关系

Bridge 模块可以：
- 扩展 — 新增 Action
- 覆盖 — 修改已有 Action 的 policy、在 handler 前后插入逻辑、或完全替换 handler

```typescript
import { overrideAction } from '@linchkit/core'

// 前后插入逻辑
export const ovr = overrideAction('submit_request', {
  before: async (ctx) => { /* 原 handler 之前 */ },
  after: async (ctx) => { /* 原 handler 之后 */ },
})

// 完全替换
export const ovr = overrideAction('submit_request', {
  handler: async (ctx) => { /* 替换 */ },
})
```

## 8. 批量操作

### 8.1 批量执行

通过 Command Layer 的 `batch_actions` 命令批量执行同一个 Action：

- 一次调用传入多条记录的 input 数组
- 产生一个父 Execution，每条记录一个子 Execution

### 8.2 批量模式优化

- **Rule 评估合并**：同一批数据只做一次 Rule 收集（匹配 trigger），每条记录独立评估 condition
- **事务策略**：
  - `all_or_nothing`（默认）：所有记录在同一事务内，任一失败全部回滚
  - `partial`：每条记录独立事务，返回成功/失败明细
- **Event 合并**：批量产生的同类事件可合并为一个批量事件（如 `record.batch_created`），减少 Outbox 记录数

### 8.3 部分成功响应

`partial` 模式下的响应结构：

- `succeeded`: 成功的记录 ID 列表 + 各自的 executionId
- `failed`: 失败的记录 ID 列表 + 各自的错误信息（错误分类见 33_error_handling.md）
- `summary`: { total, succeeded, failed }

## 9. 变更方式

所有 Action 变更（声明式和代码式）走统一路径：
- 修改 TS 文件 → 构建 → 蓝绿部署
- Source of truth 始终是 TS 文件 / Git
- 不区分"可热更新"和"需要部署"，所有变更走同一条路
