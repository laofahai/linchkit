# Schema Interface — 跨 Schema 共享行为与形状

> Status: Draft | Date: 2026-03-23
> 灵感来源: Palantir Foundry Interfaces（2024 新增，Object Type 多态）
> 里程碑: M3

## 1. 问题

多个 Schema 经常需要共享相同的字段和行为。例如：

- `purchase_request`、`leave_request`、`expense_report` 都需要审批流（`status`、`approver`、`approved_at`）
- `product`、`customer`、`supplier` 都需要软删除（`is_archived`、`archived_at`）
- `invoice`、`payment`、`refund` 都需要金额和币种（`amount`、`currency`）

当前没有机制表达这种共性。每个 Schema 独立定义字段，导致：
- **重复定义**：相同字段在多个 Schema 中反复声明
- **行为不统一**：审批流的字段名/状态名在不同 Schema 中可能不一致
- **Rule 不可复用**：审批规则要为每个 Schema 单独写
- **AI 无法泛化**：AI 不知道哪些 Schema 具有相同能力
- **View 不可复用**：审批状态组件要为每个 Schema 单独适配

## 2. 方案：defineInterface

引入 `defineInterface` — 声明一组可被多个 Schema 实现的字段和行为契约。

```typescript
import { defineInterface } from '@linchkit/core'

// 定义「可审批」接口
export const Approvable = defineInterface({
  name: 'approvable',
  label: '可审批',
  description: '实现此接口的 Schema 具有审批流能力',

  // 接口要求的字段
  fields: {
    status: {
      type: 'string',
      enum: ['draft', 'submitted', 'approved', 'rejected'],
      default: 'draft',
    },
    approver_id: { type: 'ref', target: 'user', required: false },
    approved_at: { type: 'datetime', required: false },
    rejection_reason: { type: 'text', required: false },
  },

  // 接口要求的状态机
  state: {
    initial: 'draft',
    transitions: [
      { from: 'draft', to: 'submitted', action: 'submit' },
      { from: 'submitted', to: 'approved', action: 'approve' },
      { from: 'submitted', to: 'rejected', action: 'reject' },
      { from: 'rejected', to: 'draft', action: 'revise' },
    ],
  },

  // 接口提供的通用 Action 模板
  actions: {
    submit: { label: '提交', requiredFields: ['status'] },
    approve: { label: '审批', requiredFields: ['status', 'approver_id'] },
    reject: { label: '驳回', requiredFields: ['status', 'rejection_reason'] },
  },
})
```

## 3. Schema 实现 Interface

```typescript
defineSchema({
  name: 'purchase_request',
  implements: ['approvable', 'auditable'],   // 声明实现的接口

  fields: {
    title: { type: 'string', required: true },
    amount: { type: 'number', required: true },
    department_id: { type: 'ref', target: 'department' },
    // status, approver_id, approved_at, rejection_reason
    // 由 Approvable 接口自动注入，无需重复声明
  },
})
```

### 3.1 字段注入规则

- Interface 声明的字段自动注入到实现它的 Schema
- 如果 Schema 已有同名字段，Schema 的定义优先（可覆盖默认值）
- 如果类型不兼容，启动时报错

### 3.2 状态机合并

- 如果 Interface 声明了 state，且 Schema 没有自定义 state，直接使用接口的状态机
- 如果 Schema 有自定义 state，必须包含接口要求的所有状态和迁移（超集）
- 多个接口的状态机不允许冲突

## 4. InterfaceDefinition 完整结构

```typescript
interface InterfaceDefinition {
  name: string                    // 唯一标识
  label: string
  description?: string

  // 要求的字段（注入到实现 Schema）
  fields: Record<string, FieldDefinition>

  // 可选：状态机模板
  state?: {
    initial: string
    transitions: StateTransition[]
  }

  // 可选：Action 模板（名称 + 元数据，具体 handler 由 Schema 自行实现）
  actions?: Record<string, {
    label: string
    requiredFields?: string[]     // Action 需要的字段
    description?: string
  }>
}
```

## 5. 基于 Interface 的通用 Rule

Interface 最大的价值之一：**Rule 可以针对接口编写，自动适用于所有实现它的 Schema。**

```typescript
defineRule({
  name: 'approval_deadline_check',
  label: '审批超时提醒',

  // 不是针对特定 Schema，而是针对接口
  interface: 'approvable',

  trigger: { on: 'action', action: 'submit' },
  condition: { always: true },
  effect: {
    type: 'set_field',
    field: 'approval_deadline',
    value: { $addDays: ['$now', 3] },
  },
})
```

这条 Rule 自动适用于 `purchase_request`、`leave_request`、`expense_report` — 所有实现了 `approvable` 的 Schema。

## 6. 基于 Interface 的通用 View

```typescript
defineView({
  name: 'approval_status_badge',
  interface: 'approvable',         // 不绑定特定 Schema

  type: 'widget',
  config: {
    widget: 'status_badge',
    field: 'status',
    colors: {
      draft: 'gray',
      submitted: 'blue',
      approved: 'green',
      rejected: 'red',
    },
  },
})
```

所有实现 `approvable` 的 Schema 自动获得此 View 组件。

## 7. InterfaceRegistry

```typescript
interface InterfaceRegistry {
  /** 注册一个 Interface */
  register(iface: InterfaceDefinition): void

  /** 获取 Interface 定义 */
  get(name: string): InterfaceDefinition | null

  /** 获取某个 Schema 实现的所有 Interface */
  interfacesOf(schemaName: string): InterfaceDefinition[]

  /** 获取实现某个 Interface 的所有 Schema */
  implementors(interfaceName: string): string[]

  /** 检查某个 Schema 是否实现了某个 Interface */
  implements(schemaName: string, interfaceName: string): boolean

  /** 列出所有 Interface */
  list(): InterfaceDefinition[]
}
```

## 8. 预定义 Interface

框架内置常用 Interface（可选使用）：

| Interface | 字段 | 用途 |
|-----------|------|------|
| `approvable` | status, approver_id, approved_at, rejection_reason | 审批流 |
| `auditable` | created_by, updated_by, change_log | 审计追踪 |
| `archivable` | is_archived, archived_at, archived_by | 软删除 |
| `taggable` | tags (M:N link) | 标签系统 |
| `commentable` | comments_count | 评论/Chatter |
| `prioritizable` | priority (enum: low/medium/high/urgent) | 优先级 |

内置 Interface 由 Capability 提供（如 `cap-approval` 提供 `approvable`），核心不绑定。

## 9. 验证（启动时）

系统启动时自动验证：

| 检查项 | 行为 |
|--------|------|
| Schema 声明 `implements` 但 Interface 不存在 | 报错 |
| Interface 要求的字段类型与 Schema 已有字段类型冲突 | 报错 |
| Interface 状态机与 Schema 自定义状态机冲突 | 报错 |
| 多个 Interface 要求同名字段但类型不同 | 报错 |
| 一切正常 | 字段注入 + 状态机合并 + 注册到 InterfaceRegistry |

## 10. 与 Ontology 集成（spec 43）

SchemaDescriptor 增加 `interfaces` 字段：

```typescript
interface SchemaDescriptor {
  // ...existing fields...
  interfaces: InterfaceDefinition[]   // 此 Schema 实现的所有 Interface
}
```

AI 可以查询「所有可审批的实体」：

```typescript
const approvableSchemas = ontology.interfaceRegistry.implementors('approvable')
// ['purchase_request', 'leave_request', 'expense_report']
```

## 11. 与现有 Spec 的关系

| Spec | 关系 |
|------|------|
| 03_schema | Interface 字段注入到 Schema |
| 05_rule | Rule 可以针对 Interface 编写 |
| 06_state | Interface 可以定义状态机模板 |
| 13_view_and_ui | View 可以针对 Interface 编写 |
| 20_extension_mechanism | Capability 可以提供 Interface 定义 |
| 43_ontology_layer | Ontology 聚合 Interface 信息 |

## 12. 不做什么

- **不做 Interface 继承** — Interface 之间不继承。保持扁平。
- **不做运行时 Interface 检查** — Interface 合规在启动时静态验证，运行时不检查。
- **不做 Interface 版本管理** — Interface 修改直接变更，不保留历史版本。
- **不自动生成 Action handler** — Interface 的 `actions` 只是元数据模板，handler 由 Schema 各自实现。

## 13. 里程碑

### M3
- `defineInterface()` 类型定义 + `InterfaceRegistry`
- Schema `implements` 声明 + 字段注入
- 启动时验证
- Rule 的 `interface` 字段支持
- 接入 OntologyRegistry

### M4
- 预定义 Interface（approvable, auditable, archivable）作为独立 Capability 提供
- View 的 `interface` 字段支持
- MCP 工具：`list_interfaces`、`find_implementors`
- Interface 合规报告（哪些 Schema 部分实现了接口）
