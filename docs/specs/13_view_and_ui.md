# View 与 UI 设计规范

> **UI 架构原则**：UI 不是 Core 的一部分，而是由 Capability 提供。
>
> - `cap-adapter-ui-react` — 官方 UI Shell Capability（React + Shadcn + TanStack），在 `capabilities/` 中。内含基础组件库（原 ui-kit）。
> - 各业务 Capability — 通过 `defineCapability({ pages, views })` 声明自己的页面和视图
> - 第三方可实现其他 UI Shell（如 cap-adapter-ui-vue），只要遵守相同的 View/Widget 抽象声明
>
> 安装 Capability 自动获得 UI 页面，卸载后路由自动移除。不需要 UI 的应用（如纯 MCP 或 Headless API）不安装 cap-adapter-ui-react 即可。
>
> **UI 与逻辑完全解耦**：Core 中的 ViewDefinition、FormLayout、WidgetDefinition 都是纯数据声明，不包含任何框架特定代码（无 React/Vue/Angular 依赖）。Capability 只声明"要什么"，UI Shell 负责"怎么渲染"。
>
> - `extensions.viewTypes` 中的自定义视图类型（map, gantt 等）由 UI Shell 注册具体渲染组件
> - Widget Registry 由 UI Shell 维护（cap-adapter-ui-react 用 React 组件，cap-adapter-ui-vue 用 Vue 组件）
> - 没装任何 UI Shell → 所有 pages/views 声明被忽略，系统以 Headless 模式运行
>
> cap-adapter-ui-react 负责：
> - 路由注册（扫描所有 Capability 的 `pages` 声明）
> - Sidebar 导航（根据 Capability 的 category + pages 自动生成）
> - AutoForm / AutoList（Schema 驱动的通用表单和列表）
> - Widget Registry（字段级 React 组件注册/覆盖）
> - 主题 / i18n / 响应式布局

## 1. 定位

View 是 Capability 元模型的一部分，定义业务数据的展示方式。

```
Capability = Schema + Action + Rule + State + Event + EventHandler + View + Flow
```

LinchKit 提供 headless 的 View 渲染引擎：
- **逻辑层**：LinchKit 核心提供，纯逻辑
- **渲染层**：默认 Shadcn + Lucide + Tailwind，用户可替换

## 2. AI-Native 设计原则

LinchKit 的 UI 不是"传统后台 + AI 聊天框"，也不是"全屏聊天替代一切"。核心理念：

> **AI 是工作台上的工具，不是独立界面。传统视图是基础原语，AI 增强它们而不是取代它们。**

以下原则基于 2025-2026 年主流产品演进（Microsoft Copilot、Notion AI、Atlassian Rovo、Linear、Cursor）的实际验证结果：

### 2.1 传统视图是基础原语

List、Form、Detail、Kanban、Dashboard 等 CRUD 视图不会消失 — 它们是数据操作的基本单元。AI-native 的工作区是**容器**，CRUD 视图是容器内的**内容组件**。

Height App（AI-native PM 工具）的关停证明：AI 创新不能替代产品基本面。Linear 的设计宣言："AI 不替代工作台，它是放在工作台上的工具。随着 Agent 工作流增长，工作台反而变得更重要。"

### 2.2 Inline-First，按需面板

AI 的存在感通过**内联**体现，不是常驻侧边栏。

研究依据：
- Microsoft Copilot 侧边栏被大量用户忽视，Microsoft 已在 2026 年 3 月回撤部分集成
- GitHub Copilot 成功的核心是内联补全，不是侧边面板
- Cursor/Windsurf 的成功模式是分层交互：Tab（微补全）→ Cmd+K（内联编辑）→ Cmd+I（按需 Agent 面板）

LinchKit 中的对应：
- **内联提示**：表单字段旁的 AI 建议、列表行内的异常标注、Action 按钮旁的风险指示 — 类似 IDE linting
- **按需面板**：用户主动触发时展开 AI 协作面板（上下文摘要、深度分析、对话）
- **不做**：常驻右侧 AI 栏，always-on 的 AI 面板

### 2.3 Intent Preview 模式

自然语言是入口，结构化对象是终点。中间有一个关键环节：**Intent Preview**。

```
自然语言输入 → Intent 识别 → 计划展示（Preview）→ 用户确认 → Action 执行
```

用户可以从 Command Palette 用自然语言发起任务（"帮我提交这个采购申请"），系统展示将要执行的 Action、影响的对象、命中的 Rule，用户确认后执行。AI 输出必须**对象化** — 沉淀为 Proposal、草稿、工单、审批项，不停留在聊天记录里。

### 2.4 治理可视化内联

LinchKit 是治理型系统，执行治理不应该在单独的 Dashboard 里，而应该**内联在操作点**。

Action 执行前，内联展示：
- 将执行什么 Action
- 影响哪些对象
- 命中哪些 Rule（拦截/警告/审批）
- 风险等级
- 是否需要审批

这类似 IDE 在代码旁显示 warning/error，而不是把所有问题放到单独面板。目前没有企业软件做好这一点（研究确认），这是 LinchKit 的差异化机会。

### 2.5 单一自适应工作区，不做模式切换

不做"任务模式 / 对象模式 / 画布模式 / 执行模式"的切换。

研究依据：
- ServiceNow UX 研究：多 Tab 切换是最大痛点
- Nielsen Norman Group：模式设计是 Top 10 应用设计错误之一
- Notion 的模式：一个 workspace 渐进暴露复杂功能

LinchKit 的做法：**一个工作区，根据上下文渐进式披露**。对象详情页上，基本信息、关联对象、AI 分析、执行历史、审批链都是同一页面的不同区块，按需展开/收起，不是不同模式。

### 2.6 架构分层但 UX 统一

Runtime（业务执行）、Design（建模配置）、Evolution（治理审批）在**架构上分层**（路由、权限、数据源不同），在**用户体验上统一**。

不做三个独立应用。同一个 SPA，同一套导航，角色驱动的内容过滤。`system_admin` 看到 Schema 浏览和 Proposal 管理，业务用户只看到自己的待办和业务页面。

这与 SAP Fiori 的演进方向一致：统一设计系统 + 角色驱动内容适配。

## 3. 架构分层

```
逻辑层（@linchkit/core 提供，headless）
  ├── View 定义解析
  ├── 数据获取（query / get）
  ├── Action 调用
  ├── 表单状态管理（校验、提交）
  ├── 权限判断（字段可见性、按钮可用性）
  └── 导出 hooks / renderless components

渲染层（@linchkit/ui 提供，用户可替换）
  ├── 默认主题（Shadcn + Lucide + Tailwind）
  ├── 用户自定义主题
  └── 完全自定义组件
```

## 4. 使用方式

### 3.1 开箱即用 — 默认组件

```tsx
import { LinchList, LinchForm } from '@linchkit/ui'

// 直接用，默认样式
<LinchList view="purchase_request_list" />
<LinchForm view="purchase_request_form" id={recordId} />
```

### 3.2 自定义渲染 — 用 hooks 拿逻辑

```tsx
import { useListView, useFormView } from '@linchkit/core/ui'

function MyCustomList() {
  const { fields, data, loading, sort, pagination, filters, actions } = useListView('purchase_request_list')

  return (
    <div className="my-custom-layout">
      {/* 完全自由的 UI */}
    </div>
  )
}

function MyCustomForm({ id }) {
  const { layout, values, errors, submit, availableActions } = useFormView('purchase_request_form', id)

  return (
    <form onSubmit={submit}>
      {/* 完全自由的 UI */}
    </form>
  )
}
```

### 3.3 混合 — 部分用默认，部分自定义

```tsx
import { LinchForm, LinchField, LinchActions } from '@linchkit/ui'

// 用 LinchForm 的逻辑，但自定义布局
<LinchForm view="purchase_request_form" id={recordId}>
  {({ values, errors, availableActions }) => (
    <div className="my-layout">
      <LinchField name="title" />           {/* 用默认字段渲染 */}
      <MyCustomAmountField value={values.amount} />  {/* 自定义字段 */}
      <LinchActions actions={availableActions} />     {/* 用默认按钮 */}
    </div>
  )}
</LinchForm>
```

## 5. View 定义

### 4.1 列表视图（list）

```typescript
import { defineView } from '@linchkit/core'

export const requestList = defineView({
  name: 'purchase_request_list',
  schema: 'purchase_request',
  type: 'list',

  fields: [
    { field: 'title' },
    { field: 'amount', format: 'currency' },
    { field: 'department.name' },
    { field: 'requester.name' },
    { field: 'status', display: 'badge' },
    { field: 'request_date', format: 'date' },
  ],

  filters: [
    { field: 'status', type: 'select' },
    { field: 'department', type: 'select' },
    { field: 'request_date', type: 'dateRange' },
  ],

  defaultSort: { field: 'created_at', order: 'desc' },

  actions: ['create_request'],   // 列表上方的操作按钮

  rowActions: ['submit_request', 'cancel_request'],  // 每行的操作按钮
})
```

### 4.1.1 List View Advanced Features — Unified SearchBar Architecture

The list view uses a **unified SearchBar** approach (inspired by Odoo Search View and Linear) where all filtering lives inside a single input-like component:

```
┌─────────────────────────────────────────────────────────────────────┐
│ ListToolbar                                                         │
│  ┌─────────────────────────────────────┐                            │
│  │ 🔍 [pill: status=draft ×] [pill ×] │ ▼ × │  [+ Create] [⋯]    │
│  │     SearchBar (text + filters)      │      │                     │
│  └─────────────────────────────────────┘                            │
├─────────────────────────────────────────────────────────────────────┤
│ TanStack Table (sorting, selection, widget-rendered cells)           │
├─────────────────────────────────────────────────────────────────────┤
│ Pagination                                                          │
└─────────────────────────────────────────────────────────────────────┘
```

#### SearchBar — Unified Search + Filter Component

`components/auto-list/search-bar.tsx` — The primary search and filtering interface:

- **Global fuzzy text search**: Free-text input that filters across all columns via TanStack Table's `globalFilter`
- **bazza/ui filter selector**: Icon button (▼) inside the search bar opens a popover to add field-level filters. Schema fields are auto-mapped to filter types via `filter-columns.ts`
- **Active filter pills**: Applied filters display as inline removable pills (bazza `ActiveFilters` component) within the search bar, before the text input
- **Clear all**: Single `×` button clears both text search and all filter pills
- Focus ring on the container, click-to-focus on the input area

#### filter-columns.ts — Schema-to-Filter Bridge

`components/auto-list/filter-columns.ts` — Converts `SchemaDefinition` fields into bazza `ColumnConfig[]`:

| LinchKit Field Type | bazza ColumnDataType | Notes |
|---------------------|---------------------|-------|
| `string`, `text` | `text` | Text contains filter |
| `number` | `number` | Min/max computed from data |
| `date`, `datetime` | `date` | Date range filter |
| `enum`, `state` | `option` | Options from field def or data |
| `boolean` | `option` | Yes/No options |
| `computed`, `ref`, `json`, `has_many`, `many_to_many` | *(skipped)* | Not filterable |

#### ListToolbar — Single-Row Layout

`components/auto-list/list-toolbar.tsx` — Arranges the toolbar as:

- **Left**: SearchBar (unified search + filters)
- **Right**: Primary action button + overflow menu (⋯) with secondary actions, column toggle, export
- **Bulk mode**: When rows are selected, shows count + bulk action dropdown + clear selection button

#### Data Filtering Pipeline

1. bazza `useDataTableFilters` hook manages filter state using `DeclarativeCondition`-compatible operators (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `in`, `not_in`, `between`)
2. `AutoList` pre-filters data using bazza filter state before passing to TanStack Table
3. TanStack Table applies global text filter and column sorting on the pre-filtered data
4. Selection state resets automatically when filters change

#### TanStack Table — Data Grid

The core table powered by TanStack Table v8:
- Column header click to sort
- Row selection + batch operations
- Pagination (offset-based, configurable `pageSize`)
- Cells rendered via Widget Registry (`columns.ts` → `widgetRegistry`)
- State fields rendered with `StatusBadge` using `state-colors.ts`

#### Tool Chain

| Tool | Purpose |
|------|---------|
| bazza/ui fork (`components/data-table-filter/`) | Linear-style filter UI, modified to use `ComparisonOperator` from LinchKit `DeclarativeCondition` format |
| TanStack Table | Sorting, pagination, global text filter, row selection |
| `DeclarativeCondition` | Unified filter format shared with Rule engine |
| Widget Registry | Field-type-aware cell rendering in table columns |

### 4.2 表单视图（form）

```typescript
export const requestForm = defineView({
  name: 'purchase_request_form',
  schema: 'purchase_request',
  type: 'form',

  layout: [
    { row: [{ field: 'title', span: 16 }, { field: 'status', span: 8, readonly: true }] },
    { row: [{ field: 'department', span: 12 }, { field: 'requester', span: 12 }] },
    { row: [{ field: 'amount', span: 8 }, { field: 'request_date', span: 8 }] },
    { field: 'description' },

    // 子表（一对多）
    { field: 'items', type: 'table', columns: [
      { field: 'product_name' },
      { field: 'quantity' },
      { field: 'unit_price' },
      { field: 'subtotal', computed: true },
    ]},

    // 底部汇总
    { field: 'total_amount', readonly: true },
  ],

  // 根据状态显示不同的 Action 按钮
  actions: {
    draft: ['submit_request', 'cancel_request'],
    submitted: ['approve_request', 'reject_request'],
    approved: ['confirm_purchase'],
    purchased: ['complete_request'],
  },
})
```

### 4.3 看板视图（kanban）

```typescript
export const requestKanban = defineView({
  name: 'purchase_request_kanban',
  schema: 'purchase_request',
  type: 'kanban',

  groupBy: 'status',
  card: {
    title: 'title',
    subtitle: 'requester.name',
    fields: ['amount', 'department.name'],
    color: '$status.color',
  },
})
```

### 4.4 仪表盘（dashboard）

```typescript
export const purchaseDashboard = defineView({
  name: 'purchase_dashboard',
  type: 'dashboard',

  widgets: [
    { type: 'stat', label: '本月采购总额', query: { schema: 'purchase_request', aggregate: { sum: 'amount' } } },
    { type: 'stat', label: '待审批', query: { schema: 'purchase_request', filter: { status: 'submitted' }, aggregate: 'count' } },
    { type: 'chart', chartType: 'bar', label: '各部门采购额', query: { ... } },
    { type: 'list', view: 'purchase_request_list', filter: { status: 'submitted' }, limit: 5 },
  ],
})
```

## 6. View 类型

| 类型 | 说明 | 里程碑 |
|------|------|--------|
| `list` | 列表/表格 | M0 |
| `form` | 表单（创建/编辑/查看） | M0 |
| `detail` | 只读详情（增强版，含时间线/关联/AI 内联） | M0 |
| `workspace` | 首页工作台（任务聚合 + AI 关注项 + 快速发起） | M0 |
| `kanban` | 看板 | M1 |
| `dashboard` | 仪表盘（图表/统计） | M1 |
| `calendar` | 日历视图 | M2 |
| `tree` | 树形视图 | M2 |

## 7. 布局优先级链

View 的最终布局由以下层叠加决定（从低到高）：

### 6.1 框架智能默认（最低优先级）

如果 Schema 没有定义任何 View，框架根据**字段类型 + Presentation 元数据 + 字段 ui 属性**自动生成合理布局。

**表单自动布局规则**（参考 Directus 的 width 模型 + 语义分组）：

字段宽度推断（基于 12 列 Grid）— 字段 `ui.width` > 以下类型默认值：

| 字段类型 | 默认 span | 理由 |
|---------|----------|------|
| string / enum / ref | 6（半宽） | 短文本，两个一行 |
| number / date / datetime | 4（1/3 宽） | 紧凑数值 |
| boolean | 3（1/4 宽） | 开关很小 |
| text / json | 12（全宽） | 长内容独占一行 |
| has_many / many_to_many | 12（全宽） | 子表格独占 |
| state | 4 | 状态徽章 |

自动分组与排序 — 字段 `ui.importance` 和 `ui.group` 优先，否则退回以下规则：
1. **头部区**：`presentation.titleField` + `presentation.badgeField`（置顶）；无 presentation 时取 title/name + status
2. **核心区**：`ui.importance: 'primary'` 的字段，或 `required: true` 的字段
3. **补充区**：`ui.importance: 'secondary'` 的字段，或 `required: false` 的普通字段
4. **关联区**：ref / belongsTo 字段
5. **子表区**：has_many 字段，各自独占一个 section
6. **详情区**：`ui.importance: 'detail'` 的字段（默认折叠）
7. **系统区**：created_at / updated_at / created_by 等（折叠到底部）

同一 `ui.group` 的字段自动放在一起。智能配对：同语义字段自动放同一行（如 start_date + end_date、first_name + last_name、price + currency）。

**列表自动列选择**（最多 6-7 列）：

优先级：`presentation.titleField` > `presentation.badgeField` > `presentation.summaryFields` > `ui.importance: 'primary'` > 必填短字段 > 关联字段 > created_at。排除长文本、JSON、密码、子表等不适合列表展示的类型。

**卡片模式**（手机端、搜索结果、工作台待办）：

直接消费 `presentation` 元数据：titleField 做标题、subtitleField 做副标题、badgeField 做徽章、summaryFields 做摘要字段。无 presentation 时退回到列表自动列选择的前 3 个字段。

### 6.2 AI 辅助生成（开发时）

AI 分析字段语义关系，生成更优的布局建议，输出为 `defineView` 代码：

```bash
linch generate view purchase_request --ai
```

AI 可以做到规则引擎做不到的事：
- 识别"地址相关字段"应该在一起
- 根据业务语境决定字段分组（不只是按类型）
- 建议合理的 tab 分组

**AI 不参与运行时布局计算**（不确定性、延迟、成本），只在开发阶段生成代码，开发者审核后提交。

### 6.3 开发者 defineView（显式覆盖）

开发者通过 defineView 完全控制布局，覆盖自动生成的默认值：

```typescript
defineView({
  name: 'purchase_request_form',
  schema: 'purchase_request',
  type: 'form',
  layout: [
    { row: [{ field: 'title', span: 16 }, { field: 'status', span: 8, readonly: true }] },
    // ...
  ],
})
```

### 6.4 Bridge extendView（模块扩展）

Bridge 模块通过节点级操作精确修改已有 View（见第 9 节 View 扩展机制）。

### 6.5 租户覆盖（最高优先级）

SaaS 模式下租户在 DB 中的声明式覆盖，见 30_multi_tenancy.md。

### 6.6 合并顺序

```
框架智能默认 → AI 生成（开发者审核后变成 defineView）→ defineView → extendView（按 priority）→ 租户覆盖
```

每一层覆盖上一层。如果开发者写了 defineView，框架默认不再使用；如果 Bridge 做了 extendView，在 defineView 基础上叠加。

## 8. Action 按钮与状态联动

表单上显示哪些 Action 按钮由以下信息自动判断：

1. **State Machine** — 当前状态允许哪些 transition
2. **Action permissions** — 当前用户有没有权限
3. **View 定义** — actions 字段指定了哪些按钮

框架自动处理按钮的可见性和可用性，开发者不需要手动判断。

## 9. View 扩展机制

### 8.1 节点级扩展

Bridge、租户覆盖不需要重写整个 View，可以精确定位节点进行插入/替换/删除。

**核心设计决策**（对比调研 Odoo xpath、JSON Patch RFC 6902、Payload CMS plugin、Backstage extension 后确定）：
- **基于语义（name）定位，而非位置（index/xpath）** — 避免 Odoo xpath 的脆弱路径依赖和 JSON Patch 的索引漂移问题
- **受约束的操作集** — 不暴露原始 Visitor/Transformer API，只提供 `extendView`
- **冲突检测 + 解析日志** — 这是 Odoo 最大的教训，多层继承后无法追溯

```typescript
import { extendView } from '@linchkit/core'

export const ext = extendView('purchase_request_form', {
  priority: 10,  // 数值小的先执行，默认 100
  operations: [
    // 在 amount 字段后面插入新字段
    {
      target: { field: 'amount' },
      position: 'after',
      insert: { field: 'budget_remaining', readonly: true },
    },

    // 替换 description 字段的渲染方式
    {
      target: { field: 'description' },
      position: 'replace',
      insert: { field: 'description', type: 'rich_text' },
    },

    // 在 submit 按钮前面加一个按钮
    {
      target: { action: 'submit_request' },
      position: 'before',
      insert: { action: 'save_draft', label: 't:save_draft' },
    },

    // 删除某个字段
    {
      target: { field: 'legacy_field' },
      position: 'remove',
    },

    // 子表中的字段（消歧义）
    {
      target: { field: 'unit_price', in: 'items' },
      position: 'after',
      insert: { field: 'discount_rate' },
    },

    // 向预留 slot 注入内容
    {
      target: { slot: 'form_header' },
      position: 'inside',
      insert: { field: 'priority_tag', display: 'badge' },
    },
  ],
})

// 列表视图也支持 — 给列表加一列
export const extList = extendView('purchase_request_list', {
  priority: 10,
  operations: [
    {
      target: { field: 'status' },
      position: 'after',
      insert: { field: 'inbound_status', display: 'badge' },
    },
  ],
})
```

### 8.2 target 定位语法

| target 形式 | 说明 | 示例 |
|-------------|------|------|
| `{ field: 'name' }` | 按字段名定位 | `{ field: 'amount' }` |
| `{ action: 'name' }` | 按 Action 按钮名定位 | `{ action: 'submit_request' }` |
| `{ section: 'name' }` | 按 section/group 名定位 | `{ section: 'basic_info' }` |
| `{ slot: 'name' }` | 按预留 slot 名定位 | `{ slot: 'form_header' }` |
| `{ widget: 'name' }` | Dashboard 中按 widget 名定位 | `{ widget: 'monthly_chart' }` |
| `{ field: 'name', in: 'parent' }` | 子表/嵌套中的字段消歧义 | `{ field: 'price', in: 'items' }` |

### 8.3 position 类型

| position | 说明 |
|----------|------|
| `before` | 在目标前面插入 |
| `after` | 在目标后面插入 |
| `replace` | 替换目标（同一 target 的 replace 互斥，冲突报错） |
| `remove` | 删除目标（删除后该节点不可再被 target） |
| `wrap` | 用容器包裹目标 |
| `inside` | 追加到目标内部（用于 section/slot） |

### 8.4 多扩展合并策略

多个 Bridge/租户覆盖同时修改同一个 View 时：

1. **按 priority 排序**（数值小的先执行，默认 100）
2. **冲突检测**：
   - 同一 target 的 `replace` 互斥 → 报冲突错误
   - `remove` 后的节点不可再被 target → 后续操作产生警告
   - `after`/`before` 不冲突 → 按 priority 顺序排列
3. **操作日志**：每个操作记录来源（哪个 Bridge/租户覆盖），用于调试

### 8.5 View Resolution Engine

```
View 定义（JSON AST）
    │
    ├── extendView operations（多个 Bridge/租户覆盖，各带 priority）
    │
    ▼
View Resolution Engine
    ├── 1. 收集所有 extensions，按 priority 排序
    ├── 2. Visitor 模式遍历 View AST，按 target 语义定位节点
    ├── 3. 冲突检测（replace 互斥、remove 后不可 target）
    ├── 4. 应用操作（immer 不可变更新）
    ├── 5. 生成 operation log + warnings
    └── 6. 输出 Resolved View + Debug Info
```

### 8.6 调试工具

**View Resolution Log**（开发模式）：每个 resolved view 携带完整解析日志

```bash
linchkit view:resolve purchase_request_form
# 输出：
# Base: purchase_management/purchase_request_form
# Extensions:
#   [priority 10] inbound_bridge: 3 operations (3 applied, 0 skipped)
#   [priority 200] tenant_override: 1 operation (1 applied, 0 skipped)
# Warnings: none
```

**View Diff 工具**：

```bash
linchkit view:diff purchase_request_form
# 输出类似 git diff，每个变更标注来源
# + field: budget_remaining  [source: inbound_bridge]
# ~ field: description → type: rich_text  [source: tenant_override]
# - field: legacy_field  [source: cleanup_bridge]
```

**Source Annotation**：Resolved view 中每个被修改/插入的节点携带 `_source` 元数据，React DevTools 中可追溯。

### 8.7 完整覆盖

如果节点级扩展不够，可以完整覆盖 View 布局：

```typescript
import { overrideView } from '@linchkit/core'

export const ovr = overrideView('purchase_request_form', {
  layout: [
    // 全新的布局定义
  ],
})
```

### 8.8 底层实现

- View 定义内部表示为 **JSON AST**，渲染层消费 AST 产出 React 组件
- 操作定义用 **zod** 校验合法性（注册时报错，不等到运行时）
- 节点更新用 **immer** 做不可变操作
- 不对外暴露 Visitor/Transformer API，保证所有扩展都是可预测、可追溯的

## 10. UI 架构

### 9.1 单应用、角色驱动

**管理端和业务端是同一个 SPA，不做两个独立应用。**

- 路由分两类：`/admin/*`（系统管理页面）和 `/{capability}/*`（业务页面）
- 导航菜单根据用户权限自动过滤 — `system_admin` 看到全部，业务用户只看到自己有权限的 Capability
- 系统管理页面（Dashboard、Capability 列表、Schema 浏览、Event 时间线等）由框架内置
- 业务页面由 defineView 自动生成或自定义
- Runtime / Design / Evolution 三个关注面在架构上分层（见 2.6），在用户界面上统一呈现

### 9.2 布局结构

整体布局：**顶部命令栏 + 左侧导航 + 中间工作区**。不做常驻右侧 AI 面板。

```
┌─────────────────────────────────────────────────────────┐
│  顶部命令栏：Command Palette 入口 + 通知 + Agent 状态    │
├──────────┬──────────────────────────────────────────────┤
│          │                                              │
│  左侧    │              主工作区                         │
│  导航    │                                              │
│          │  ┌─────────────────────────────────────────┐ │
│  · 工作台 │  │ 业务视图（list / form / detail / ...）   │ │
│  · 模块   │  │                                         │ │
│  · 管理   │  │ AI 内联提示（字段旁、行内、按钮旁）       │ │
│          │  │                                         │ │
│          │  │ ┌───────────────────────────────────┐   │ │
│          │  │ │ 按需 AI 面板（用户触发时滑出）     │   │ │
│          │  │ └───────────────────────────────────┘   │ │
│          │  └─────────────────────────────────────────┘ │
└──────────┴──────────────────────────────────────────────┘
```

#### 顶部命令栏

不只是品牌条，而是**全局命令入口**：

- Command Palette 触发（Cmd+K）— 自然语言搜索、跳转、发起 Action
- 当前空间 / 租户 / 环境切换
- 通知中心（铃铛 + 未读计数）
- Agent 状态指示（有后台任务运行时显示）
- 用户头像 + 设置入口

#### 左侧导航

地位从"主入口"降级为"系统地图"，但**必须保留**：

- 提供稳定的模块入口和权限边界
- 支持高频操作的肌肉记忆
- 培训与审计友好

支持两种位置，通过 `linchkit.config.ts` 配置：

```typescript
ui: {
  menuPosition: 'left' | 'top',  // 默认 'left'
}
```

- **左侧菜单**（默认）：Capability 多时更实用，支持树形展开、折叠为图标模式
- **顶部菜单**：Capability 少时更简洁，下拉展开子菜单

两种模式共享同一套菜单数据（来自 defineNavigation），只是渲染位置不同。

#### 主工作区

承载所有业务视图（list / form / detail / kanban / dashboard 等）。AI 能力以两种方式嵌入工作区：

**内联 AI 提示**（始终可见，轻量）：
- 表单字段旁：AI 填充建议、校验提示、关联数据摘要
- 列表行内：异常标注（如"此单据金额异常偏高"）、状态预测
- Action 按钮旁：风险等级指示、Rule 命中预览
- 实现方式：轻量模型 + 预计算缓存，不实时调用大模型

**按需 AI 面板**（用户触发时展开）：
- 从工作区右侧滑出，不常驻
- 内容：上下文摘要、深度分析、对话交互、推荐动作、证据引用
- 触发方式：点击内联提示的"展开分析"、快捷键、Command Palette
- 关闭后不占用屏幕空间

### 9.3 首页工作台

首页不是传统的 KPI 仪表盘，而是**任务驱动的工作台**：

| 区块 | 内容 | 数据来源 |
|------|------|----------|
| **我的任务** | 待我处理的审批、待确认的 Proposal、状态流转中需要我操作的单据 | 跨 Capability 聚合，基于 Actor 权限 |
| **AI 关注项** | Rule 触发的异常、EventHandler 产生的告警、AI 识别的风险 | Rule Engine + Event Bus |
| **我的对象** | 用户收藏/负责的业务记录，最近访问的对象 | 用户偏好 + 访问历史 |
| **快速发起** | Command Palette 的自然语言入口，常用 Action 快捷方式 | defineAction + 使用频率统计 |

工作台本身也是一个 View（type: `workspace`），可以通过 `defineView` 自定义，但框架提供开箱即用的默认实现。

### 9.4 对象详情页增强

传统详情页只是字段堆砌。AI-native 的对象详情页围绕**对象状态与动作**组织，渐进式披露：

```
┌─────────────────────────────────────────────┐
│ 顶部：标题 + 状态徽章 + 关键指标 + 主 Action │
├─────────────────────────────────────────────┤
│ 主数据区（Schema 字段，按 presentation 分组）  │
│                                             │
│ [AI 内联] 字段旁的建议/警告/关联摘要          │
├─────────────────────────────────────────────┤
│ 关联对象（ref 字段展开、has_many 子表）        │
├─────────────────────────────────────────────┤
│ 时间线 / 事件历史（Event + ExecutionLog）     │
│ 审批链（配合 35_approval_mechanism.md）       │
├─────────────────────────────────────────────┤
│ 系统信息（created_at 等，默认折叠）            │
└─────────────────────────────────────────────┘
```

详情页的结构由 **Schema Presentation 元数据**（见 03_schema.md）驱动：
- `titleField` 决定顶部标题
- `badgeField` 决定状态徽章
- `summaryFields` 决定关键指标
- 字段 `importance` 决定主数据区的分组和排序

### 9.5 执行治理可视化

Action 执行前，**内联展示治理信息**（类似 IDE 在代码旁显示 warning）：

```typescript
// 用户点击 Action 按钮后，执行前展示 Preview
interface ActionPreview {
  action: string                    // 将执行的 Action
  affectedRecords: RecordRef[]      // 影响的对象
  ruleHits: {                       // 命中的 Rule
    rule: string
    level: 'block' | 'warn' | 'require_approval'
    message: string
  }[]
  riskLevel: 'low' | 'medium' | 'high'
  requiresApproval: boolean         // 是否需要审批
  stateTransition?: {               // 状态流转
    from: string
    to: string
  }
}
```

展示方式：
- **低风险 + 无审批**：Toast 确认，一键执行
- **中风险 或 有 Rule 警告**：弹出 Preview 卡片，显示影响和命中规则，确认后执行
- **高风险 或 需要审批**：展开完整 Preview 面板，显示影响分析、审批链、回滚信息

### 9.6 响应式设计

基于 Tailwind 断点，三级适配：

| 断点 | 布局 | 菜单 | 表格 | 表单 | AI 面板 |
|------|------|------|------|------|---------|
| **桌面**（>1024px） | 完整双栏 | 左侧/顶部菜单 | 完整表格 | 多列布局 | 右侧滑出 |
| **平板**（768-1024px） | 菜单收缩为图标 | 点击展开 overlay | 自动隐藏低优先级列 | 两列→单列 | 底部 sheet 滑出 |
| **手机**（<768px） | 单栏 | 底部导航栏（Tab Bar） | 卡片列表替代表格 | 单列全宽 | 独立页面/全屏 modal |

手机端列表从表格切换为**卡片模式**：每条记录一张卡片，显示 title + status + 关键字段（由 Schema Presentation 的 `summaryFields` 驱动）。

AI 内联提示在所有断点保持可见（它们是轻量标注，不占额外空间）。按需 AI 面板在小屏幕上**不常驻**，改为底部 sheet 或独立页面。

### 9.7 PWA 支持

通过 vite-plugin-pwa 配置：

- **添加到主屏幕**：manifest.json，自定义图标和启动画面
- **推送通知**：配合 cap-notification + WebSocket，审批待办实时推送
- **离线缓存**：Service Worker 缓存 App Shell（HTML/JS/CSS），数据请求需在线
- 不做完整离线数据同步（业务操作依赖数据库，离线写入一致性问题太复杂）

### 9.8 全局交互组件

以下全局组件均以**系统 Capability** 形式提供（见 14_system_capabilities.md），不硬编码在框架内核中。业务 Capability 可以通过 extensions 机制注册自己的快捷键、Command 等。

#### @linchkit/cap-command-palette

Command Palette（Cmd+K），**全局命令入口**，不只是搜索：
- **语义搜索**：跨 Capability 搜索记录（标题/名称匹配 + 自然语言理解）
- **快速导航**：输入 Capability 名或 View 名跳转
- **Action 执行**：输入 Action 名或自然语言描述，触发 Intent Preview 流程
- **自然语言入口**：支持 "帮我查上个月超过 5 万的采购申请" 这类意图
- 基于 Shadcn 的 `cmdk` 组件
- 其他 Capability 可通过 extensions 注册自定义 command

Intent 处理流程：
```
用户输入自然语言 → AI 解析为结构化 Intent
  → 如果是查询：直接展示结果（列表/对象）
  → 如果是操作：进入 Intent Preview → 用户确认 → 执行 Action
  → 如果模糊：展示候选项让用户选择
```

#### @linchkit/cap-keyboard-shortcuts

统一快捷键注册和管理：
- 提供 `registerShortcut` 扩展接口，业务 Capability 注册自己的快捷键
- 内置默认快捷键（Cmd+K 打开搜索、E 编辑、Esc 取消、Ctrl+Enter 提交等）
- 冲突检测：两个 Capability 注册同一快捷键时警告
- 用户可在设置中自定义快捷键绑定

#### @linchkit/cap-notification（已在 14 中定义）

通知中心，顶部命令栏铃铛图标：
- 审批待办（配合 35_approval_mechanism.md）
- Rule 拦截提醒、系统告警
- AI 关注项推送（异常检测、风险预警）
- WebSocket 实时推送，未读计数角标

#### @linchkit/cap-ai-assistant

AI 协作能力（按需面板 + 内联提示的运行时支撑）：
- 提供 `useAIInsight(schemaName, recordId)` hook — 获取记录级 AI 分析
- 提供 `useActionPreview(actionName, input)` hook — 获取 Action 执行预览
- 提供 AI 面板的 UI 组件（上下文摘要、推荐动作、证据引用、对话）
- 管理 AI 调用的缓存和节流（避免 always-on 的性能和成本问题）
- 信任校准：AI 建议使用语义标签（"高/中/低 置信度"），不展示原始概率数字

#### 面包屑导航

面包屑是**框架内核 UI Shell 的一部分**（不是 Capability），因为它是基础导航能力：
- 从路由和 Capability/View 定义自动生成
- 格式：`采购管理 > 采购申请 > PR-001`
- 不需要手动配置

### 9.9 表格高级功能

列表 View 默认支持（基于 TanStack Table）：

- 列排序（点击表头）
- 列显隐（用户可选择显示哪些列，偏好存 localStorage）
- 列宽拖拽
- 固定列（左侧固定 title 列，右侧固定操作列）
- 行选择 + 批量操作（勾选多行 → 显示批量操作栏）
- 单元格内联编辑（可选，View 定义中配置 `inlineEdit: true`）
- AI 内联标注（行级异常提示、趋势指示，由 cap-ai-assistant 提供数据）

### 9.10 表单高级功能

- **自动保存草稿**：编辑中的数据每 30 秒自动存 localStorage，提交成功后清除。下次打开表单恢复草稿。
- **离开提醒**：表单有未保存变更时，导航离开弹出确认框
- **字段变更高亮**：编辑时变更过的字段视觉高亮，方便 review
- **AI 辅助填写**：字段旁的内联 AI 建议（如根据标题自动推荐部门、根据历史数据建议金额）

### 9.11 主题系统

- **暗色/亮色模式**：Shadcn + Tailwind 天然支持，用户切换，偏好存 localStorage
- **品牌色**：SaaS 模式下租户可自定义主色调（CSS 变量覆盖），通过 tenant config 配置
- **Logo**：租户可上传自定义 logo（依赖 cap-file-storage）

### 9.12 无障碍（Accessibility）

- 所有交互元素键盘可导航（Tab 顺序、焦点管理）
- AI 内联提示和面板状态通过 ARIA live region 通报给辅助技术
- AI 置信度指示器不仅用颜色，同时提供文字标签（如 "高风险" 而不只是红色）
- 流式 AI 响应完成后再通报给 screen reader（避免逐字朗读）
- 遵循 WCAG 2.1 AA 标准

## 11. 前端技术栈

| 层面 | 选型 | 理由 |
|------|------|------|
| 框架 | React | 动态渲染场景成熟，hooks 体系适合 headless 架构 |
| 路由 | TanStack Router | Type-safe routing |
| UI 组件 | Shadcn UI | headless 理念一致，可定制性强 |
| 图标 | Lucide | 与 Shadcn 配套 |
| 样式 | Tailwind CSS | 与 Shadcn 配套，utility-first |
| 数据获取 | TanStack Query | GraphQL 查询缓存、乐观更新 |
| 表格 | TanStack Table | headless table，排序/筛选/分页/列控制 |
| 表单 | React Hook Form + Zod | 与 Schema 的 Zod 产物直接复用 |
| Command Palette | cmdk | Shadcn 集成 |
| 图表 | Recharts | React 生态，声明式，与 Shadcn 风格一致 |
| PWA | vite-plugin-pwa | 零配置 PWA 支持 |

## 12. View 与 Command Layer / GraphQL 的关系

View 层通过统一 Command Layer 获取数据和执行操作（详见 16_command_layer_and_api.md）：

- **读数据**：View 的 fields 定义自动转成 GraphQL query，通过 Command Layer 的 `query` command 获取
- **写数据**：Action 按钮触发 Command Layer 的 `execute_action` command
- **权限**：Command Layer 自动附加数据权限，View 层无需处理

```tsx
// useListView 内部自动生成 GraphQL query
const { data } = useQuery(`{
  purchaseRequests(filter: ..., sort: ...) {
    items { id title amount status }
  }
}`)

// Action 按钮
await executeAction('submit_request', { id })
```

## 13. 导航与菜单

Capability 安装后自动出现在导航中。通过 `defineNavigation` 定义菜单结构：

```typescript
import { defineNavigation } from '@linchkit/core'

export const nav = defineNavigation({
  capability: 'purchase_management',
  label: '采购管理',
  icon: 'shopping-cart',        // Lucide 图标名
  order: 10,                    // 排序

  items: [
    { label: '采购申请', view: 'purchase_request_list', icon: 'file-text' },
    { label: '看板', view: 'purchase_request_kanban', icon: 'columns' },
    { label: '仪表盘', view: 'purchase_dashboard', icon: 'bar-chart' },
  ],
})
```

如果 Capability 没有定义 navigation，框架自动生成：
- 菜单名 = Capability label
- 子菜单 = 每个 Schema 的 list view

Bridge 模块可以扩展导航（给已有菜单加项）。

导航可见性自动受权限控制 — 用户看不到没权限的菜单项。

## 14. 待定问题

- 富文本编辑器选型（TipTap / Lexical / Plate）
- 文件上传组件的详细设计（依赖 cap-file-storage）
- 图表库最终确认（Recharts vs ECharts）
- WebSocket 连接管理和频道模型的详细设计
- AI 内联提示的具体触发策略（哪些字段/场景自动触发、哪些用户手动触发）
- AI 辅助填写的模型选型（轻量本地模型 vs 云端 API，延迟与成本平衡）
- Command Palette 的自然语言 Intent 解析实现方案（MCP 工具调用 vs 自定义 parser）
- Action Preview 的影响分析深度（只分析直接影响 vs 级联影响）
