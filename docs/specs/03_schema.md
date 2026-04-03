# Schema 设计规范

## 1. 定位

Schema 是 LinchKit 的数据基础。所有其他概念（Action、Rule、State、Event）都围绕 Schema 运转。

## 2. 与 Zod 的关系

**不强关联 Zod。** LinchKit Schema 是自己的元模型，Zod 只是输出产物之一。

```
LinchKit Schema（源头）
       ↓
  自动生成：
       ├── Zod schema     → 运行时输入校验
       ├── Drizzle schema → 数据库建表和查询
       ├── TypeScript type → 开发时类型推导
       ├── GraphQL type   → 读操作查询
       └── JSON Schema    → MCP / API 对外描述
```

定义一次，多处使用。不被任何三方库锁死。

## 3. 定义方式

```typescript
import { defineEntity } from '@linchkit/core'

export const purchaseRequest = defineEntity({
  name: 'purchase_request',
  label: '采购申请',

  // Presentation 元数据 — 告诉 View 层"这个对象怎么被理解和展示"
  presentation: {
    titleField: 'title',
    subtitleField: 'requester.name',
    badgeField: 'status',
    summaryFields: ['amount', 'department.name', 'request_date'],
    icon: 'file-text',
  },

  fields: {
    // 基础字段
    title:        { type: 'string', required: true, label: '标题',
                    ui: { importance: 'primary' } },
    amount:       { type: 'number', required: true, min: 0, max: 1000000, label: '金额',
                    ui: { importance: 'primary', format: 'currency' } },
    description:  { type: 'text', label: '说明',
                    ui: { importance: 'secondary' } },
    request_date: { type: 'date', default: 'now', label: '申请日期' },

    // 关联字段
    department:   { type: 'ref', target: 'department', required: true, label: '部门' },
    requester:    { type: 'ref', target: 'employee', required: true, label: '申请人' },

    // 状态字段 — 绑定状态机
    status:       { type: 'state', machine: 'request_lifecycle', label: '状态',
                    ui: { display: 'badge' } },

    // 一对多
    items:        { type: 'has_many', target: 'purchase_item', label: '采购明细' },

    // 派生字段 — 运行时计算，不存数据库
    total_amount: {
      type: 'computed',
      compute: (record) => record.items.reduce((sum, item) => sum + item.subtotal, 0),
      label: '总金额',
      ui: { importance: 'primary', format: 'currency' },
    },
  },
})
```

## 4. 基础字段类型

| 类型 | 说明 | 数据库映射 |
|------|------|-----------|
| `string` | 短文本 | varchar |
| `text` | 长文本 | text |
| `number` | 数字（整数/浮点） | numeric / integer |
| `boolean` | 布尔 | boolean |
| `date` | 日期 | date |
| `datetime` | 日期时间 | timestamp |
| `enum` | 枚举，预定义选项 | varchar + check |
| `json` | 自由结构 JSON | jsonb |
| `ref` | 关联另一个 Schema（多对一） | foreign key |
| `has_many` | 一对多（虚拟字段，不存储） | — |
| `many_to_many` | 多对多 | 中间表 |
| `state` | 绑定状态机 | varchar |
| `computed` | 派生字段，不存储 | — |

## 5. 字段约束

```typescript
{
  required: true,           // 必填
  unique: true,             // 唯一
  min: 0,                   // 最小值（number）/ 最小长度（string）
  max: 1000000,             // 最大值 / 最大长度
  format: 'email',          // 预定义格式（email, url, phone 等）
  default: 'now',           // 默认值（字面量或预定义函数）
  immutable: true,          // 创建后不可修改
}
```

## 5a. Presentation 元数据

Schema 除了定义"数据怎么存"，还需要声明"数据怎么被理解和展示"。Presentation 元数据为 View 层的自动布局、对象详情页、卡片模式、Command Palette 搜索结果等提供语义依据。

**这不是绑定具体 UI 组件，而是声明语义**。View 层消费这些语义来决定展示方式。

### Schema 级 Presentation

```typescript
defineEntity({
  name: 'purchase_request',
  label: '采购申请',

  presentation: {
    titleField: 'title',                    // 对象标题（用于卡片、搜索结果、面包屑）
    subtitleField: 'requester.name',         // 副标题
    badgeField: 'status',                    // 状态徽章
    summaryFields: ['amount', 'department.name', 'request_date'],  // 关键指标（用于卡片、工作台）
    icon: 'file-text',                       // Lucide 图标名（用于导航、搜索结果）
  },

  fields: { /* ... */ },
})
```

| 属性 | 说明 | 消费者 |
|------|------|--------|
| `titleField` | 对象的显示标题 | 卡片模式、Command Palette、面包屑、关联字段展示 |
| `subtitleField` | 副标题/描述 | 卡片模式、搜索结果 |
| `badgeField` | 状态/分类徽章 | 卡片模式、列表行内、对象详情顶部 |
| `summaryFields` | 关键指标（最多 3-4 个） | 手机端卡片、工作台待办摘要、对象详情顶部 |
| `icon` | Schema 图标 | 导航菜单、搜索结果、关联字段 |

### 字段级 UI 提示

字段可以携带 `ui` 属性，提供展示语义提示（不是绑定组件）：

```typescript
fields: {
  title:        { type: 'string', required: true, label: '标题',
                  ui: { importance: 'primary' } },
  amount:       { type: 'number', required: true, label: '金额',
                  ui: { importance: 'primary', format: 'currency' } },
  status:       { type: 'state', machine: 'request_lifecycle', label: '状态',
                  ui: { display: 'badge' } },
  description:  { type: 'text', label: '说明',
                  ui: { importance: 'secondary' } },
  internal_note:{ type: 'text', label: '内部备注',
                  ui: { importance: 'detail' } },
}
```

| ui 属性 | 可选值 | 说明 |
|---------|--------|------|
| `importance` | `'primary'` / `'secondary'` / `'detail'` | 字段展示优先级。primary 出现在列表和摘要中，secondary 出现在表单主区域，detail 折叠到详情区 |
| `format` | `'currency'` / `'percentage'` / `'filesize'` / `'duration'` | 数值/文本的格式化提示 |
| `display` | `'badge'` / `'progress'` / `'avatar'` / `'color'` / `'rating'` | 展示形式提示 |
| `group` | 任意字符串（如 `'financial'` / `'contact'`） | 语义分组，自动布局时同组字段放在一起 |
| `width` | `3` / `4` / `6` / `8` / `12` | 表单中的栅格宽度提示（基于 12 列），覆盖类型推断的默认值 |

**优先级**：字段 `ui` 属性 > 13_view_and_ui.md 中的类型推断默认值 > defineView 显式布局（最高优先级覆盖一切）。

如果 Schema 没有定义 `presentation` 和字段 `ui`，框架退回到纯类型推断（见 13_view_and_ui.md 第 7.1 节）。

## 5b. State Field — List View Presentation

When a Schema has a state field, it can be configured as the **primary navigation axis** in list views via the State Ribbon.

```typescript
// Field-level: mark as ribbon primary
status: {
  type: 'state',
  machine: 'request_lifecycle',
  label: '状态',
  ui: {
    display: 'badge',
    ribbonPrimary: true,   // Show as State Ribbon in list views
  },
}

// Schema-level: presentation.stateRibbon config
presentation: {
  titleField: 'title',
  badgeField: 'status',
  stateRibbon: {
    enabled: true,          // Enable State Ribbon for list views
    field: 'status',        // Which state field drives the ribbon
  },
}
```

The State Ribbon renders all states from `StateFieldConfig.states` as clickable tabs with record counts. Clicking a state applies a `DeclarativeCondition` filter: `{ field: "status", operator: "eq", value: "submitted" }`. See `13_view_and_ui.md` for full list view architecture.

## 6. 系统自动字段

每个 Schema 自动包含以下字段，不需要手动定义：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | cuid2 | 主键 |
| `tenant_id` | string | 租户 ID（多租户隔离） |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |
| `created_by` | ref(actor) | 创建人 |
| `updated_by` | ref(actor) | 更新人 |
| `_version` | number | 乐观锁版本号 |

`tenant_id` 从 M0 就预留，查询自动附加租户过滤。

## 7. Schema 扩展与覆盖（Bridge 用）

Bridge 模块可以扩展和覆盖已有 Schema：

### 扩展 — 加新字段
```typescript
import { extendSchema } from '@linchkit/core'

export const ext = extendSchema('purchase_request', {
  fields: {
    inbound_status: { type: 'ref', target: 'inbound_order.status', readonly: true, label: '入库状态' },
  }
})
```

### 覆盖 — 修改已有字段属性
```typescript
import { overrideSchema } from '@linchkit/core'

export const ovr = overrideSchema('purchase_request', {
  fields: {
    amount: { max: 5000000 },        // 修改上限
    description: { required: true },  // 改为必填
  }
})
```

覆盖只能修改字段属性，不能改变字段类型（如从 string 改成 number）。

扩展字段在数据库中的存储方式待定（独立表 vs JSONB 列 vs 直接加列）。

## 8. 接口暴露控制

Schema 和字段级别的接口暴露：

```typescript
defineEntity({
  name: 'employee',

  // Schema 级别 — 哪些接口可以查询这个 Schema
  exposure: {
    graphql: true,      // GraphQL 可查（默认 true）
    mcp: true,          // MCP 可查（默认 true）
  },

  fields: {
    name: { type: 'string' },
    salary: { type: 'number', sensitive: true },
    id_number: { type: 'string', secret: true },
  },

  // 字段级别 — 覆盖默认暴露
  fieldExposure: {
    salary: { graphql: true, mcp: false },       // AI 查不到薪资
    id_number: { graphql: false, mcp: false },    // 只有内部可用
  },
})
```

五层访问控制汇总：

| 控制层 | 控制什么 | 定义位置 |
|--------|---------|----------|
| Action exposure | Action 能被哪些接口调用 | defineAction |
| Schema exposure | 数据能被哪些接口查询 | defineEntity |
| Field exposure | 字段能被哪些接口看到 | defineEntity.fieldExposure |
| Permission | 谁能操作 | definePermissionGroup |
| systemPermissions | Capability 能用哪些系统资源 | defineCapability |

## 9. 变更方式与数据库 Schema 管理

### 9.1 Source of Truth

- **始终是 TS 文件 / Git**，不在数据库中存储 Schema 定义
- DB 只存业务数据，不存元定义
- 每个 Capability 通过 `defineEntity()` 声明 Schema（静态 TS 代码）

### 9.2 Schema → Database 映射流程

```
linchkit.config.ts (声明 capabilities)
       ↓ linch CLI 读取
所有 EntityDefinition + Core 系统表
       ↓ generateDrizzleTable() 自动转换
.linchkit/drizzle-schema.generated.ts (自动生成的 barrel file)
       ↓ drizzle-kit 读取
数据库同步
```

**关键设计：** `linch` CLI 从 config 加载所有 capability，收集 EntityDefinition，通过 `generateDrizzleTable()` 转换为 Drizzle pgTable 定义，写入一个自动生成的 schema barrel file。drizzle-kit 读取这个文件来管理数据库。

这确保了：
- npm 安装的三方 capability 包可以正常工作（config import 即可）
- capability 放在任意目录都行（跟着 config 走）
- 不重复造轮子，完全依赖 drizzle-kit 管理表结构

### 9.3 Capability 的 Drizzle Table 导出约定

每个定义了 Schema 的 capability **应当** 在包中导出对应的 Drizzle table 定义：

```typescript
// capabilities/cap-purchase-demo/src/drizzle-tables.ts
import { generateDrizzleTable } from "@linchkit/core/server";
import { purchaseRequestSchema } from "./schemas/purchase-request";

export const purchaseRequestTable = generateDrizzleTable(purchaseRequestSchema);
```

`linch` CLI 在生成 `.linchkit/drizzle-schema.generated.ts` 时，优先使用 capability 显式导出的 table；若无导出，则自动从 EntityDefinition 生成。

### 9.4 CLI 命令

| 命令 | 作用 | 环境 |
|------|------|------|
| `linch dev` | 自动生成 schema barrel → `db:generate` → `migrate()` → 启动服务 | 开发 |
| `linch db:generate` | 生成 schema barrel → `drizzle-kit generate`（生成 migration SQL） | 开发 + 生产部署前 |
| `linch db:migrate` | `migrate()` from `drizzle-orm/postgres-js/migrator`（执行 migration） | 开发 + 生产部署时 |
| `linch db:studio` | `drizzle-kit studio`（数据库可视化） | 调试 |

### 9.5 开发 vs 生产

- **开发时：** `linch dev` 自动 `db:generate` → `migrate()`，修改 Schema 重启即生效。Dev 可 reset（drop DB + delete migrations + regenerate）
- **生产变更：** `linch db:generate` 生成 migration SQL → 人工审核 → `linch db:migrate` 执行 → 蓝绿部署。Migration 文件 append-only，不可删除已应用的 migration
- **回滚：** 通过 drizzle-kit migration journal 管理，每次 migration 有完整 snapshot
- **注意：** `drizzle-kit push`（`pushSchema()` API）在 Bun 上有已知 bug（introspection 阶段挂起），因此统一使用 `migrate()` API

## 10. 待定问题

- number 类型是否需要细分 integer / decimal / float？
- 文件/附件类型是否作为基础类型？
- 多语言字段（i18n）如何处理？
- Schema 继承 / 抽象 Schema（比如所有"单据"共享一些字段）是否需要？
- 扩展字段的存储方式
