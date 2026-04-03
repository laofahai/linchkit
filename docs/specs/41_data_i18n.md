# 数据多语言（Data i18n）设计规范

## 1. 定位

LinchKit 中存在三层 i18n：

| 层次 | 内容 | 方案 | 状态 |
|------|------|------|------|
| UI 字符串 | 按钮、提示文案 | react-i18next, JSON 翻译文件 | 已完成 |
| Schema 元数据 | schema.label, field.label | `t:` 前缀约定 + i18next | 已完成 |
| **业务数据** | 用户录入的多语言内容 | 本文档定义 | 待实现 |

本文档解决第三层：**业务数据的多语言存储、查询和展示**。

典型场景：产品名称需要中英文、商品描述需要多语言、枚举选项的显示文本需要翻译。

## 2. 业界方案对比

### 2.1 Odoo — 翻译表模式

```
ir_translation(src_model, src_field, src_id, lang, value)
```

- 独立翻译表，按 model + field + record + lang 存翻译
- 优点：Schema 无侵入，任意字段可翻译
- 缺点：大量 JOIN，查询性能差；翻译与数据分离，一致性难保证

### 2.2 Strapi — 内容版本模式

- 每条记录按 locale 存一个完整副本
- `article (id=1, locale='en')` 和 `article (id=2, locale='zh')` 是两行，通过 `localizations` 关联
- 优点：查询简单，每个 locale 独立
- 缺点：数据冗余大；非翻译字段（如 price）也重复存储；关联关系复杂

### 2.3 Directus — 翻译关联模式

- 主表存默认语言 + 不可翻译字段
- 单独 `xxx_translations(id, xxx_id, language, field1, field2...)` 表存翻译
- 优点：只翻译需要翻译的字段，无冗余
- 缺点：每个 Schema 多一张表，JOIN 成本

### 2.4 Payload CMS — 字段内联模式

- 可翻译字段在 DB 中展开为 `title_en`, `title_zh` 列
- 或用 JSONB：`title: { en: "...", zh: "..." }`
- 优点：无 JOIN，查询最快
- 缺点：新增语言需改表（列模式）；JSONB 模式难以索引

### 2.5 PostgreSQL JSONB 模式

```sql
-- 字段存为 JSONB
title jsonb  -- {"en": "Purchase Order", "zh-CN": "采购订单"}
```

- 优点：灵活，加语言无需改表，单次查询
- 缺点：无法直接对翻译文本建普通索引（需 GIN/表达式索引）；JSONB 存储开销略大

## 3. LinchKit 方案选择

**采用 JSONB 内联模式**。理由：

| 考量 | 结论 |
|------|------|
| KISS | JSONB 最简单，无额外表、无 JOIN |
| 性能 | 单次查询拿到所有翻译，无 N+1 |
| Schema code-first | 无需额外维护翻译表的 Drizzle schema |
| 灵活性 | 新增语言无需 migration |
| Drizzle 兼容 | Drizzle 原生支持 `jsonb` 列 |
| 索引 | 对需要搜索的翻译字段可建 GIN 索引或表达式索引 |

**不选翻译表的原因**：LinchKit 的 Schema 是 code-first，翻译表需要额外的运行时元数据管理，违背 "DB 只存业务数据，不存元定义" 原则。

**不选内容版本的原因**：冗余太大，关联关系复杂化。

## 4. Schema 定义

### 4.1 标记可翻译字段

在 `defineSchema` 中，通过 `translatable: true` 标记可翻译字段：

```typescript
export const product = defineSchema({
  name: 'product',
  label: 't:schema.product',

  // 声明此 Schema 启用数据多语言
  i18n: {
    defaultLocale: 'zh-CN',  // 默认语言（必填）
  },

  fields: {
    name:        { type: 'string', required: true, label: '名称',
                   translatable: true },
    description: { type: 'text', label: '描述',
                   translatable: true },
    sku:         { type: 'string', required: true, label: 'SKU' },
                   // 不可翻译 — SKU 是标识符
    price:       { type: 'number', label: '价格' },
                   // 不可翻译 — 数字无需翻译
    category:    { type: 'ref', target: 'category', label: '分类' },
                   // 不可翻译 — 引用无需翻译
  },
})
```

**规则**：
- 只有 `string`、`text`、`enum`（options.label）类型的字段可标记 `translatable`
- 其他类型标记 `translatable` 将在构建时报错
- Schema 必须声明 `i18n.defaultLocale` 才能使用 `translatable` 字段

### 4.2 类型定义扩展

```typescript
// schema.ts 新增

interface SchemaI18nConfig {
  /** Default locale for this schema's data */
  defaultLocale: string
}

// BaseFieldDefinition 新增
interface BaseFieldDefinition extends FieldConstraints {
  // ... existing fields
  /** Mark field content as translatable across locales */
  translatable?: boolean
}
```

## 5. 数据库存储

### 5.1 存储结构

可翻译字段在 DB 中存储为 JSONB，**但只在字段有多语言值时**才使用 JSONB 格式。

```sql
-- Drizzle 自动生成的表结构
CREATE TABLE product (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  name       jsonb NOT NULL,   -- translatable → jsonb
  description jsonb,            -- translatable → jsonb
  sku        varchar NOT NULL,  -- 普通字段 → varchar
  price      numeric,
  -- ... system fields
);
```

### 5.2 JSONB 值格式

```jsonc
// name 字段的存储值
{
  "zh-CN": "采购订单模板",
  "en": "Purchase Order Template"
}
```

- key 是 locale code（与 `supportedLanguages` 一致）
- value 是对应语言的文本
- 默认语言的值**必须存在**

### 5.3 索引策略

```sql
-- 对需要搜索/排序的翻译字段，建表达式索引
CREATE INDEX idx_product_name_zh ON product ((name->>'zh-CN'));
CREATE INDEX idx_product_name_en ON product ((name->>'en'));

-- 全文搜索用 GIN
CREATE INDEX idx_product_name_gin ON product USING GIN (name);
```

索引由开发者在 Drizzle migration 中按需添加，框架不自动创建。

## 6. Drizzle Schema 生成

Schema Engine 为可翻译字段生成 `jsonb` 类型而非 `varchar`/`text`：

```typescript
// 自动生成的 Drizzle schema（示意）
import { pgTable, text, jsonb, numeric } from 'drizzle-orm/pg-core'

export const product = pgTable('product', {
  id:          text('id').primaryKey(),
  tenant_id:   text('tenant_id').notNull(),
  name:        jsonb('name').notNull(),      // translatable string → jsonb
  description: jsonb('description'),          // translatable text → jsonb
  sku:         text('sku').notNull(),          // 普通 string → text
  price:       numeric('price'),
  // ...
})
```

## 7. 读写 API

### 7.1 写入

写入时传入对象格式：

```typescript
// 创建记录 — 传入多语言值
await actions.product.create({
  name: {
    'zh-CN': '采购订单模板',
    'en': 'Purchase Order Template',
  },
  description: {
    'zh-CN': '标准采购流程使用的订单模板',
  },
  sku: 'TPL-001',
  price: 0,
})

// 也可以只传默认语言的值（快捷写法）
// 引擎自动包装为 { [defaultLocale]: value }
await actions.product.create({
  name: '采购订单模板',  // 等价于 { 'zh-CN': '采购订单模板' }
  sku: 'TPL-001',
  price: 0,
})
```

**快捷写法规则**：如果可翻译字段收到 `string` 而非 `object`，引擎自动包装为 `{ [defaultLocale]: value }`。

### 7.2 GraphQL 查询

GraphQL 层通过 `locale` 参数控制返回语言：

```graphql
# 查询指定语言（返回扁平字符串）
query {
  products(locale: "en") {
    name          # "Purchase Order Template"
    description   # "Standard purchase order template"
    sku           # "TPL-001" (非翻译字段，不受 locale 影响)
  }
}

# 查询所有翻译（返回对象）
query {
  products {
    name_i18n {   # { "zh-CN": "采购订单模板", "en": "Purchase Order Template" }
      zhCN
      en
    }
    name          # 默认语言的值
  }
}
```

**GraphQL 类型生成规则**：

```graphql
type Product {
  name: String!           # 解析为请求 locale 的值（fallback chain）
  name_i18n: ProductNameI18n  # 所有翻译
  description: String
  description_i18n: ProductDescriptionI18n
  sku: String!            # 非翻译字段，正常标量
}

type ProductNameI18n {
  zhCN: String
  en: String
}
```

每个可翻译字段自动生成两个 GraphQL 字段：
- `fieldName` — 解析后的单语言值（根据请求 locale + fallback chain）
- `fieldName_i18n` — 所有翻译的对象

### 7.3 Fallback Chain

```
请求的 locale → Schema 的 defaultLocale → JSONB 中第一个有值的 key
```

例如请求 `locale: "ja"`，但记录只有 `zh-CN` 和 `en`：
1. 查找 `ja` → 无
2. 查找 `zh-CN`（defaultLocale）→ 有，返回

## 8. UI 层

### 8.1 表单编辑

可翻译字段在表单中显示语言切换 Tab：

```
┌─ 产品名称 ──────────────────────────────┐
│ [中文] [English]                         │
│ ┌──────────────────────────────────────┐ │
│ │ 采购订单模板                          │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

- 默认语言标记为必填，其他语言可选
- Tab 上未填写的语言显示空心圆点提示

### 8.2 列表展示

列表中可翻译字段根据当前 UI locale 显示对应语言值，走 fallback chain。

### 8.3 Hook

```typescript
import { useTranslatableField } from '@linchkit/cap-adapter-ui'

function ProductNameField({ value }: { value: TranslatableValue }) {
  const { currentValue, allLocales, setLocaleValue } = useTranslatableField(value)

  return <Input value={currentValue} onChange={(v) => setLocaleValue(currentLocale, v)} />
}
```

### 8.4 类型定义

```typescript
/** Value type for translatable fields */
type TranslatableValue = Record<string, string>

/** Runtime resolved value (after locale resolution) */
type ResolvedTranslatableValue = string
```

## 9. Enum 字段的翻译

Enum 的 `options.label` 也支持翻译，但使用不同机制 — 因为 enum 选项是 Schema 元数据，不是用户数据：

```typescript
fields: {
  priority: {
    type: 'enum',
    options: [
      { value: 'low',    label: 't:enum.priority.low' },
      { value: 'medium', label: 't:enum.priority.medium' },
      { value: 'high',   label: 't:enum.priority.high' },
    ],
  },
}
```

Enum 的翻译走 **Schema 元数据 i18n**（`t:` 前缀 + i18next），不走数据 i18n。这是因为 enum 选项定义在代码中，不是用户录入的。

## 10. 与其他子系统的交互

| 子系统 | 交互方式 |
|--------|----------|
| **Action** | 写入 Action 的 input validation 需支持 TranslatableValue 类型 |
| **Rule** | Rule condition 中比较翻译字段时，默认比较 defaultLocale 的值 |
| **Search / Filter** | 搜索可翻译字段时，搜索所有语言的值（JSONB 包含查询） |
| **Event** | Event payload 中翻译字段传完整 JSONB 对象 |
| **Export** | 导出时可选择语言或导出所有翻译 |
| **MCP** | MCP 返回完整 JSONB 对象，由 AI 自行选择语言 |

## 11. 实现计划

| 阶段 | 内容 | 里程碑 |
|------|------|--------|
| P1 | `BaseFieldDefinition` 增加 `translatable`；Schema Engine 生成 JSONB 列 | M1 |
| P2 | Action Engine 支持 TranslatableValue 读写 + 快捷写法 | M1 |
| P3 | GraphQL 层生成 `_i18n` 字段 + locale 参数 | M1 |
| P4 | UI 可翻译字段组件 + `useTranslatableField` hook | M2 |
| P5 | 搜索/过滤支持翻译字段 | M2 |

## 12. 待定问题

- 是否需要支持"翻译工作流"（如标记某翻译为"待审核"状态）？暂不需要，YAGNI。
- 是否需要翻译记忆 / AI 自动翻译集成？后续作为插件考虑。
- 可翻译字段的全文搜索索引策略：按需还是自动创建？当前方案为按需。
- `supportedLanguages` 是否应从全局 i18n 配置中统一读取，还是允许每个 Schema 独立定义支持的语言？建议全局配置。
