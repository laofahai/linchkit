# State Machine 设计规范

> Tracking milestones:
> - foundational meta-model reference
>
> Related issues:
> - No dedicated open issue is currently tracked for this spec.
>
> Execution source of truth: GitHub milestones and issues.

## 1. 定位

State Machine 管理业务对象的生命周期状态。状态是业务真相的一部分 — 它决定了当前能做什么操作、不能做什么操作。

## 2. 定义方式

```typescript
import { defineState } from '@linchkit/core'

export const requestLifecycle = defineState({
  name: 'request_lifecycle',
  schema: 'purchase_request',   // 绑定到哪个 Schema
  field: 'status',              // 绑定到 Schema 的哪个字段
  initial: 'draft',             // 初始状态

  states: ['draft', 'submitted', 'approved', 'rejected', 'purchased', 'completed', 'cancelled'],

  transitions: [
    { from: 'draft',      to: 'submitted',  action: 'submit_request' },
    { from: 'submitted',  to: 'approved',   action: 'approve_request' },
    { from: 'submitted',  to: 'rejected',   action: 'reject_request' },
    { from: 'approved',   to: 'purchased',  action: 'confirm_purchase' },
    { from: 'purchased',  to: 'completed',  action: 'complete_request' },
    { from: 'rejected',   to: 'draft',      action: 'revise_request' },

    // 从多个状态触发
    { from: ['draft', 'submitted'], to: 'cancelled', action: 'cancel_request' },
  ],

  // 可选：每个状态的元信息（用于 UI 展示、AI 理解）
  meta: {
    draft:     { label: '草稿',   color: 'gray' },
    submitted: { label: '已提交', color: 'blue' },
    approved:  { label: '已批准', color: 'green' },
    rejected:  { label: '已驳回', color: 'red' },
    purchased: { label: '已采购', color: 'orange' },
    completed: { label: '已完成', color: 'green' },
    cancelled: { label: '已取消', color: 'gray' },
  },
})
```

## 3. 核心设计原则

### 3.1 Transition 必须绑定 Action

每条状态迁移必须由一个 Action 触发。不允许直接修改状态字段。

这保证了：
- 状态变更一定走 Action 链路（Rule 校验、Event 记录等）
- 不会出现"状态莫名其妙变了"的情况
- 审计链路完整

### 3.2 State Machine 是声明式的

- 状态、迁移路径、元信息都是声明式数据
- 可以通过 Proposal → 蓝绿部署快速更新
- 底层使用**自研纯 TypeScript 实现**（约 200-400 行），开发者通过 defineState DSL 定义
- 不引入 XState 等第三方库，避免双重抽象，保持类型推断完全可控
- 未来如需嵌套状态/并行状态等高级特性，可将内部实现切换到 XState（DSL 接口不变）

### 3.3 Action 执行时自动校验状态

当 Action 声明了 `stateTransition: { from: 'draft', to: 'submitted' }` 时：
- 框架自动检查当前状态是否为 `from`
- 如果不是，Action 直接失败，不需要开发者手动判断

## 3a. State Machine as Primary List Navigation

In list views, the state machine becomes the **primary navigation axis** via the State Ribbon:

- All states from `definition.states` are rendered as horizontal clickable tabs
- Each tab shows the state label + current record count
- Subtle `→` arrows between states reflect valid transitions
- Clicking a state applies a `DeclarativeCondition` filter
- States with `meta.ribbonHidden: true` are excluded from the ribbon (e.g., archived states)
- Bottleneck detection: states with abnormally high record counts are visually highlighted

```typescript
// State meta can control ribbon visibility
meta: {
  draft:    { label: 'Draft', color: 'gray' },
  archived: { label: 'Archived', color: 'gray', ribbonHidden: true },
}
```

See `13_view_and_ui.md` for the full four-layer list view architecture.

## 4. 与其他概念的关系

- **Action** — Action 触发状态迁移
- **Rule** — Rule 可以监听 `stateChange` 事件，在迁移前后做判断
- **Event** — 每次状态迁移自动产生 `state.transition` 事件
- **View** — State Machine drives the State Ribbon in list views (see 13_view_and_ui.md)

## 5. 与 Bridge 的关系

Bridge 模块可以：
- 给已有状态机新增状态
- 新增迁移路径
- 覆盖状态元信息

```typescript
import { extendState } from '@linchkit/core'

export const ext = extendState('request_lifecycle', {
  states: ['on_hold'],  // 新增一个"暂挂"状态
  transitions: [
    { from: 'submitted', to: 'on_hold', action: 'hold_request' },
    { from: 'on_hold', to: 'submitted', action: 'resume_request' },
  ],
  meta: {
    on_hold: { label: '暂挂', color: 'yellow' },
  },
})
```

## 6. 实现方案

### 自研纯 TypeScript 实现

核心逻辑：`transition(definition, currentState, event, context) → nextState | null`

- 零依赖，包大小可忽略
- TypeScript const generics + template literal types 做到极致类型安全
- 支持：状态列表、合法迁移、初始状态、guard 条件、元信息（label/color）
- 约 200-400 行代码

### 升级路径

如果未来需要嵌套状态/并行状态等高级特性，可将内部实现切换到 XState v5（27k+ stars，API 已稳定），defineState DSL 接口保持不变。

## 7. 待定问题

- 嵌套状态和并行状态暂不支持，预留升级路径
- 状态迁移的 guard（前置条件）用 Rule 实现，保持 State 定义简洁

## 8. UI Visualization

State Machine 在 UI 中需要直观的可视化展示，帮助用户理解业务对象的生命周期。

### 8.1 状态图渲染

在 Schema 详情页和记录详情页中，渲染交互式状态机图：

```
┌──────┐   submit    ┌──────────┐   approve   ┌──────────┐
│ 草稿  │───────────→│  已提交   │────────────→│  已批准   │
│ gray │            │  blue    │            │  green   │
└──────┘            └──────────┘            └──────────┘
    ↑                    │                      │
    │    revise          │ reject               │ confirm
    │                    ↓                      ↓
    │               ┌──────────┐          ┌──────────┐
    └───────────────│  已驳回   │          │  已采购   │
                    │  red     │          │  orange  │
                    └──────────┘          └──────────┘
```

- 从 `defineState` 定义的 `states` + `transitions` 自动生成有向图
- 布局算法自动排列节点位置（DAG 分层布局）
- 渲染为 SVG，支持缩放和拖拽

### 8.2 状态颜色编码

每个状态节点使用 `meta.color` 定义的颜色渲染：

| color 值 | 语义 | 使用场景 |
|----------|------|----------|
| `gray` | 初始/终态/非活跃 | draft、cancelled、archived |
| `blue` | 进行中/待处理 | submitted、in_progress |
| `green` | 成功/完成 | approved、completed |
| `red` | 失败/拒绝 | rejected、failed |
| `orange` | 警告/中间态 | purchased、on_hold |
| `yellow` | 等待/暂挂 | pending、waiting |

颜色映射由 `lib/state-colors.ts` 统一管理，状态图、State Ribbon、StatusBadge 共用同一套色板。

### 8.3 迁移 Action 标签

每条迁移箭头上标注触发 Action 的 label（非 name）：

- 标签可点击，跳转到对应 Action 的定义或执行入口
- 从多个状态出发的迁移（`from: ['draft', 'submitted']`）渲染为多条箭头，各自标注相同 Action
- 鼠标 hover 迁移箭头时，tooltip 显示：Action name、是否需要权限、是否有 Rule 约束

### 8.4 记录上下文中的状态图

在记录详情页中，状态图增加当前记录上下文：

- **当前状态高亮**：当前状态节点加粗边框 + 脉冲动画
- **可用迁移高亮**：从当前状态出发的合法迁移路径以实线显示，不可达路径以虚线灰化
- **Action 按钮联动**：点击可用迁移箭头等同于点击对应 Action 按钮（进入 Action Preview 流程）
- **历史路径**：可选展示该记录经历过的状态迁移历史（从 Event 数据中提取），以时间线形式叠加在图上
