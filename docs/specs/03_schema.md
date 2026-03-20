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
import { defineSchema } from '@linchkit/core'

export const purchaseRequest = defineSchema({
  name: 'purchase_request',
  label: '采购申请',

  fields: {
    // 基础字段
    title:        { type: 'string', required: true, label: '标题' },
    amount:       { type: 'number', required: true, min: 0, max: 1000000, label: '金额' },
    description:  { type: 'text', label: '说明' },
    request_date: { type: 'date', default: 'now', label: '申请日期' },

    // 关联字段
    department:   { type: 'ref', target: 'department', required: true, label: '部门' },
    requester:    { type: 'ref', target: 'employee', required: true, label: '申请人' },

    // 状态字段 — 绑定状态机
    status:       { type: 'state', machine: 'request_lifecycle', label: '状态' },

    // 一对多
    items:        { type: 'has_many', target: 'purchase_item', label: '采购明细' },

    // 派生字段 — 运行时计算，不存数据库
    total_amount: {
      type: 'computed',
      compute: (record) => record.items.reduce((sum, item) => sum + item.subtotal, 0),
      label: '总金额',
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
defineSchema({
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
| Schema exposure | 数据能被哪些接口查询 | defineSchema |
| Field exposure | 字段能被哪些接口看到 | defineSchema.fieldExposure |
| Permission | 谁能操作 | definePermissionGroup |
| systemPermissions | Capability 能用哪些系统资源 | defineCapability |

## 9. 变更方式

- **开发时：** TS 文件中用 `defineSchema` 声明，修改后重启开发服务器
- **生产变更：** 修改 TS 文件 → 构建时自动生成 DB migration（Drizzle Kit）→ 蓝绿部署
- **Source of truth：** 始终是 TS 文件 / Git，不在数据库中存储 Schema 定义
- DB 只存业务数据，不存元定义

## 9. 待定问题

- number 类型是否需要细分 integer / decimal / float？
- 文件/附件类型是否作为基础类型？
- 多语言字段（i18n）如何处理？
- Schema 继承 / 抽象 Schema（比如所有"单据"共享一些字段）是否需要？
- 扩展字段的存储方式
