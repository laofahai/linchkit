# View 与 UI 设计规范

## 1. 定位

View 是 Capability 元模型的一部分，定义业务数据的展示方式。

```
Capability = Schema + Action + Rule + State + Event + EventHandler + View + Flow
```

LinchKit 提供 headless 的 View 渲染引擎：
- **逻辑层**：LinchKit 核心提供，纯逻辑
- **渲染层**：默认 Shadcn + Lucide + Tailwind，用户可替换

## 2. 架构分层

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

## 3. 使用方式

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

## 4. View 定义

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

## 5. View 类型

| 类型 | 说明 | 里程碑 |
|------|------|--------|
| `list` | 列表/表格 | M0 |
| `form` | 表单（创建/编辑/查看） | M0 |
| `detail` | 只读详情 | M0 |
| `kanban` | 看板 | M1 |
| `dashboard` | 仪表盘（图表/统计） | M1 |
| `calendar` | 日历视图 | M2 |
| `tree` | 树形视图 | M2 |

## 6. 布局优先级链

View 的最终布局由以下 5 层叠加决定（从低到高）：

### 6.1 框架智能默认（最低优先级）

如果 Schema 没有定义任何 View，框架根据字段类型和元数据**自动生成合理布局**。

**表单自动布局规则**（参考 Directus 的 width 模型 + 语义分组）：

字段宽度推断（基于 12 列 Grid）：

| 字段类型 | 默认 span | 理由 |
|---------|----------|------|
| string / enum / ref | 6（半宽） | 短文本，两个一行 |
| number / date / datetime | 4（1/3 宽） | 紧凑数值 |
| boolean | 3（1/4 宽） | 开关很小 |
| text / json | 12（全宽） | 长内容独占一行 |
| has_many / many_to_many | 12（全宽） | 子表格独占 |
| state | 4 | 状态徽章 |

自动分组与排序：
1. **头部区**：title/name 字段 + status 字段（置顶）
2. **核心区**：required = true 的字段（优先展示）
3. **补充区**：required = false 的普通字段
4. **关联区**：ref / belongsTo 字段
5. **子表区**：has_many 字段，各自独占一个 section
6. **系统区**：created_at / updated_at / created_by 等（折叠到底部）

智能配对：同语义字段自动放同一行（如 start_date + end_date、first_name + last_name、price + currency）。

**列表自动列选择**（最多 6-7 列）：

优先级：title/name 字段 > status 字段 > 必填短字段 > 关联字段 > created_at。排除长文本、JSON、密码、子表等不适合列表展示的类型。

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

Bridge 模块通过节点级操作精确修改已有 View（见第 8 节 View 扩展机制）。

### 6.5 租户覆盖（最高优先级）

SaaS 模式下租户在 DB 中的声明式覆盖，见 30_multi_tenancy.md。

### 6.6 合并顺序

```
框架智能默认 → AI 生成（开发者审核后变成 defineView）→ defineView → extendView（按 priority）→ 租户覆盖
```

每一层覆盖上一层。如果开发者写了 defineView，框架默认不再使用；如果 Bridge 做了 extendView，在 defineView 基础上叠加。

## 7. Action 按钮与状态联动

表单上显示哪些 Action 按钮由以下信息自动判断：

1. **State Machine** — 当前状态允许哪些 transition
2. **Action permissions** — 当前用户有没有权限
3. **View 定义** — actions 字段指定了哪些按钮

框架自动处理按钮的可见性和可用性，开发者不需要手动判断。

## 8. View 扩展机制

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

## 9. UI 架构

### 9.1 单应用、角色驱动

**管理端和业务端是同一个 SPA，不做两个独立应用。**

- 路由分两类：`/admin/*`（系统管理页面）和 `/{capability}/*`（业务页面）
- 导航菜单根据用户权限自动过滤 — `system_admin` 看到全部，业务用户只看到自己有权限的 Capability
- 系统管理页面（Dashboard、Capability 列表、Schema 浏览、Event 时间线等）由框架内置
- 业务页面由 defineView 自动生成或自定义

### 9.2 布局模式

支持两种菜单布局，通过 `linchkit.config.ts` 配置：

```typescript
ui: {
  menuPosition: 'left' | 'top',  // 默认 'left'
}
```

- **左侧菜单**（默认）：Capability 多时更实用，支持树形展开、折叠为图标模式
- **顶部菜单**：Capability 少时更简洁，下拉展开子菜单

两种模式共享同一套菜单数据（来自 defineNavigation），只是渲染位置不同。

### 9.3 响应式设计

基于 Tailwind 断点，三级适配：

| 断点 | 布局 | 菜单 | 表格 | 表单 |
|------|------|------|------|------|
| **桌面**（>1024px） | 完整双栏 | 左侧/顶部菜单 | 完整表格 | 多列布局 |
| **平板**（768-1024px） | 菜单收缩为图标 | 点击展开 overlay | 自动隐藏低优先级列 | 两列→单列 |
| **手机**（<768px） | 单栏 | 底部导航栏（Tab Bar） | 卡片列表替代表格 | 单列全宽 |

手机端列表从表格切换为**卡片模式**：每条记录一张卡片，显示 title + status + 关键字段。

### 9.4 PWA 支持

通过 vite-plugin-pwa 配置：

- **添加到主屏幕**：manifest.json，自定义图标和启动画面
- **推送通知**：配合 cap-notification + WebSocket，审批待办实时推送
- **离线缓存**：Service Worker 缓存 App Shell（HTML/JS/CSS），数据请求需在线
- 不做完整离线数据同步（业务操作依赖数据库，离线写入一致性问题太复杂）

### 9.5 全局交互组件

以下全局组件均以**系统 Capability** 形式提供（见 14_system_capabilities.md），不硬编码在框架内核中。业务 Capability 可以通过 extensions 机制注册自己的快捷键、Command 等。

#### @linchkit/cap-command-palette

Command Palette（Cmd+K），全局搜索入口：
- 跨 Capability 搜索记录（标题/名称匹配）
- 快速跳转页面（输入 Capability 名或 View 名）
- 快速执行 Action（输入 Action 名）
- 基于 Shadcn 的 `cmdk` 组件
- 其他 Capability 可通过 extensions 注册自定义 command

#### @linchkit/cap-keyboard-shortcuts

统一快捷键注册和管理：
- 提供 `registerShortcut` 扩展接口，业务 Capability 注册自己的快捷键
- 内置默认快捷键（Cmd+K 打开搜索、E 编辑、Esc 取消、Ctrl+Enter 提交等）
- 冲突检测：两个 Capability 注册同一快捷键时警告
- 用户可在设置中自定义快捷键绑定

#### @linchkit/cap-notification（已在 14 中定义）

通知中心，右上角铃铛：
- 审批待办（配合 35_approval_mechanism.md）
- Rule 拦截提醒、系统告警
- WebSocket 实时推送，未读计数角标

#### 面包屑导航

面包屑是**框架内核 UI Shell 的一部分**（不是 Capability），因为它是基础导航能力：
- 从路由和 Capability/View 定义自动生成
- 格式：`采购管理 > 采购申请 > PR-001`
- 不需要手动配置

### 9.6 表格高级功能

列表 View 默认支持（基于 TanStack Table）：

- 列排序（点击表头）
- 列显隐（用户可选择显示哪些列，偏好存 localStorage）
- 列宽拖拽
- 固定列（左侧固定 title 列，右侧固定操作列）
- 行选择 + 批量操作（勾选多行 → 显示批量操作栏）
- 单元格内联编辑（可选，View 定义中配置 `inlineEdit: true`）

### 9.7 表单高级功能

- **自动保存草稿**：编辑中的数据每 30 秒自动存 localStorage，提交成功后清除。下次打开表单恢复草稿。
- **离开提醒**：表单有未保存变更时，导航离开弹出确认框
- **字段变更高亮**：编辑时变更过的字段视觉高亮，方便 review

### 9.8 主题系统

- **暗色/亮色模式**：Shadcn + Tailwind 天然支持，用户切换，偏好存 localStorage
- **品牌色**：SaaS 模式下租户可自定义主色调（CSS 变量覆盖），通过 tenant config 配置
- **Logo**：租户可上传自定义 logo（依赖 cap-file-storage）

## 10. 前端技术栈

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

## 10. View 与 Command Layer / GraphQL 的关系

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

## 11. 导航与菜单

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

## 13. 待定问题

- 富文本编辑器选型（TipTap / Lexical / Plate）
- 文件上传组件的详细设计（依赖 cap-file-storage）
- 应用内多 Tab 工作区（是否需要？实现复杂度高）
- 图表库最终确认（Recharts vs ECharts）
- WebSocket 连接管理和频道模型的详细设计
