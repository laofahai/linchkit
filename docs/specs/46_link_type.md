# Link Type — 独立关联定义

> Status: Completed | Date: 2026-03-24
> 灵感来源: Palantir Foundry Link Type（与 Object Type 平级的一等公民）
> 里程碑: M2

## 1. 问题

当前 LinchKit 的实体关系嵌在 Schema 字段中：

```typescript
defineEntity({
  name: 'purchase_request',
  fields: {
    department_id: { type: 'ref', target: 'department' },        // 多对一
    items: { type: 'has_many', target: 'purchase_item' },        // 一对多
    tags: { type: 'many_to_many', target: 'tag' },               // 多对多
  },
})
```

问题：
- **单向定义**：从 `purchase_request` 能看到 `department`，但从 `department` 看不到 `purchase_request`
- **无关联属性**：M:N 中间表无法携带额外字段（如 `quantity`、`assigned_at`）
- **AI 难以遍历**：必须知道哪边定义了关系才能查询，没有统一的关联发现 API
- **GraphQL 查询受限**：反向关联需要额外手写 resolver
- **与 spec 24 割裂**：spec 24 的语义关联（`defineRelation`）和结构关联（Schema 字段）是两套体系

## 2. 方案：defineRelation 独立关联定义

将关联提升为与 Schema 平级的一等公民。用 `defineRelation` 独立声明，双向可导航，支持关联属性。

```typescript
import { defineRelation } from '@linchkit/core'

// 多对一
export const requestToDepartment = defineRelation({
  name: 'request_to_department',
  from: 'purchase_request',
  to: 'department',
  cardinality: 'many_to_one',
  label: { from: '所属部门', to: '采购申请' },   // 双向 label
})

// 一对多
export const requestToItems = defineRelation({
  name: 'request_to_items',
  from: 'purchase_request',
  to: 'purchase_item',
  cardinality: 'one_to_many',
  cascade: 'delete',          // 主记录删除时级联删除子记录
})

// 多对多（带关联属性）
export const orderToProducts = defineRelation({
  name: 'order_to_products',
  from: 'sales_order',
  to: 'product',
  cardinality: 'many_to_many',
  properties: {
    quantity: { type: 'number', required: true },
    unit_price: { type: 'number', required: true },
    discount: { type: 'number', default: 0 },
  },
})
```

## 3. RelationDefinition 完整结构

```typescript
interface RelationDefinition {
  name: string                    // 唯一标识
  label?: {
    from?: string                 // 从 from 视角看的 label（如「所属部门」）
    to?: string                   // 从 to 视角看的 label（如「采购申请」）
  }
  description?: string

  from: string                    // 源 Schema 名称
  to: string                     // 目标 Schema 名称
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many'

  // M:N 关联属性（生成中间表的额外字段）
  properties?: Record<string, FieldDefinition>

  // 行为
  cascade?: 'none' | 'delete' | 'nullify'   // 默认: 'none'
  required?: boolean                         // 默认: false

  // 查询优化
  indexed?: boolean              // 默认: true（外键字段自动索引）
}
```

## 4. 与 Schema 字段的关系（向后兼容）

### 4.1 共存策略

`defineRelation` 不废弃 Schema 内的 `ref` / `has_many` / `many_to_many` 字段。两者共存：

- **Schema 字段方式**：简单场景快速定义，系统自动推断为隐式 Link
- **defineRelation 方式**：需要双向导航、关联属性、或明确控制时使用

系统启动时，将 Schema 字段中的关联自动提升为隐式 RelationDefinition，与显式 `defineRelation` 合并到统一的 `RelationRegistry`。

### 4.2 冲突解决

如果同一对 Schema 之间既有 Schema 字段定义，又有 `defineRelation` 定义：
- `defineRelation` 优先（显式声明覆盖隐式推断）
- 启动时输出警告日志

## 5. RelationRegistry

```typescript
interface RelationRegistry {
  /** 注册一个 Link */
  register(link: RelationDefinition): void

  /** 获取某个 Schema 的所有关联（出和入） */
  linksFor(schemaName: string): LinkInfo[]

  /** 获取从 A 到 B 的关联 */
  linkBetween(from: string, to: string): RelationDefinition | null

  /** 获取某个 Schema 的所有出链 */
  outgoingLinks(schemaName: string): RelationDefinition[]

  /** 获取某个 Schema 的所有入链 */
  incomingLinks(schemaName: string): RelationDefinition[]

  /** 列出所有 Link */
  list(): RelationDefinition[]
}

interface LinkInfo {
  link: RelationDefinition
  direction: 'outgoing' | 'incoming'
  relatedSchema: string          // 对面的 Schema 名称
  label: string                  // 当前方向的 label
}
```

## 6. 数据库生成

### 6.1 多对一 / 一对一

在 `from` 表上生成外键列：

```sql
-- defineRelation({ from: 'purchase_request', to: 'department', cardinality: 'many_to_one' })
ALTER TABLE purchase_request ADD COLUMN department_id TEXT REFERENCES department(id);
CREATE INDEX idx_purchase_request_department ON purchase_request(department_id);
```

### 6.2 一对多

在 `to` 表上生成外键列（反向）：

```sql
-- defineRelation({ from: 'purchase_request', to: 'purchase_item', cardinality: 'one_to_many' })
ALTER TABLE purchase_item ADD COLUMN purchase_request_id TEXT REFERENCES purchase_request(id);
```

### 6.3 多对多

生成中间表：

```sql
-- defineRelation({ from: 'sales_order', to: 'product', cardinality: 'many_to_many', properties: {...} })
CREATE TABLE _rel_order_to_products (
  sales_order_id TEXT REFERENCES sales_order(id),
  product_id TEXT REFERENCES product(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC NOT NULL,
  discount NUMERIC DEFAULT 0,
  PRIMARY KEY (sales_order_id, product_id)
);
```

中间表命名规则：`_rel_{relation_name}`。

### 6.4 与 Drizzle Schema 生成集成

`generateDrizzleSchemaFile()` 需要扩展，除了处理 EntityDefinition 之外，还要处理 RelationDefinition：
- 多对一/一对一：在表上添加外键列
- 一对多：在子表上添加外键列
- 多对多：生成中间表

## 7. GraphQL 自动生成

每个 Link 自动生成双向 GraphQL resolver：

```graphql
type PurchaseRequest {
  # 由 defineRelation({ from: 'purchase_request', to: 'department' }) 生成
  department: Department

  # 由 defineRelation({ from: 'purchase_request', to: 'purchase_item' }) 生成
  items: [PurchaseItem!]!
}

type Department {
  # 反向关联自动生成
  purchaseRequests: [PurchaseRequest!]!
}
```

带关联属性的 M:N 生成 edge 类型：

```graphql
type SalesOrder {
  productEdges: [SalesOrderProductEdge!]!
}

type SalesOrderProductEdge {
  product: Product!
  quantity: Int!
  unitPrice: Float!
  discount: Float!
}
```

## 8. 与 Ontology 集成（spec 43）

RelationRegistry 接入 OntologyRegistry：

```typescript
// OntologyRegistry.describe('purchase_request') 返回的 EntityDescriptor 包含:
{
  relations: [
    { link: requestToDepartment, direction: 'outgoing', relatedSchema: 'department' },
    { link: requestToItems, direction: 'outgoing', relatedSchema: 'purchase_item' },
  ]
}
```

AI 通过 Ontology 一次查询即可获得完整的关联图。

## 9. 与 spec 24（语义关系图）的关系

| 维度 | spec 24 语义关系 | spec 46 Link Type |
|------|-----------------|-------------------|
| 层级 | 业务语义（depends_on, affects, triggers） | 数据结构（外键、中间表） |
| 定义方式 | `defineRelation`（语义） | `defineRelation`（结构） |
| 存储 | 内存关系图 | 数据库外键/中间表 |
| 用途 | AI 理解系统、影响分析 | 数据查询、GraphQL 导航 |

两者互补，不冲突。Ontology 同时聚合两者。

## 10. 不做什么

- **不废弃 Schema 内的 ref/has_many 字段** — 向后兼容，简单场景继续可用
- **不支持自引用（self-referencing）在 M2** — 树形结构（parent_id）延后到 M3
- **不做关联级联更新** — 仅支持级联删除和 nullify

## 11. 里程碑

### M2
- `defineRelation()` 类型定义 + `RelationRegistry` ✅
- Drizzle schema 生成：多对一、一对多、一对一外键 ✅
- Drizzle schema 生成：多对多中间表 + 关联属性 ✅ **(提前完成)**
- GraphQL 双向 resolver 自动生成（所有 cardinality） ✅
- M:N 关联属性查询 GraphQL ✅ **(提前完成)**
- CapabilityDefinition 支持 `links` 导出 ✅
- CLI dev 自动收集 links 并生成 schema ✅
- Schema 字段 `ref`/`has_many`/`many_to_many` 自动提升为隐式 Link ✅

### UI Components (2026-03-25)
- `ref-widget.tsx` — Reference field widget with combobox search (HasMany/ManyToOne display + input) ✅
- HasMany widget: inline sub-table display for one-to-many linked records ✅
- ManyToMany widget: tag-style display with link/unlink support ✅

### M3
- Self-referencing links (tree structures with parent_id)
- MCP tool: `traverse_links` (navigate link graph from a single record)
