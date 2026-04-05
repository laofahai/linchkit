# Schema Inheritance — Schema 继承

> Status: Draft | Date: 2026-03-23
> 里程碑: M3

## 1. 问题

业务系统中存在大量「IS-A」关系：

- `party`（参与方）→ `customer`（客户）/ `supplier`（供应商）/ `employee`（员工）
- `document`（单据）→ `invoice`（发票）/ `receipt`（收据）/ `contract`（合同）
- `request`（申请）→ `purchase_request` / `leave_request` / `expense_report`
- `asset`（资产）→ `hardware_asset` / `software_license` / `vehicle`

当前没有 Schema 继承机制，这些场景只能：
- 每个子 Schema 重复声明公共字段 → 冗余、不一致
- 用一个大 Schema + `type` 字段区分 → 字段爆炸、校验复杂
- 用 Interface 注入字段 → 解决部分问题，但不支持跨层级查询

## 2. 与 Interface（spec 47）的区别

| 维度 | Interface | 继承 |
|------|-----------|------|
| 语义 | HAS-A（具备某能力） | IS-A（是某种特化） |
| 数量 | 一个 Schema 可实现多个 Interface | 一个 Schema 只有一个父 Schema |
| 继承内容 | 仅接口声明的字段 | 父 Schema 的全部字段 |
| Action/Rule | 提供模板，handler 各自实现 | 继承父 Schema 的 Action/Rule |
| 查询 | 各自独立 | 可以查父 Schema 获得所有子记录 |
| 数据库 | 各自独立表 | 共享表或关联表（见 §5） |
| 典型用途 | `approvable`、`auditable` 等横切能力 | `party` → `customer`/`supplier` 等实体层级 |

**两者可以组合使用：**

```typescript
// customer IS-A party（继承）
// customer HAS approvable（接口）
defineEntity({
  name: 'customer',
  extends: 'party',
  implements: ['auditable'],
  fields: {
    credit_limit: { type: 'number' },
    payment_terms: { type: 'string' },
  },
})
```

## 3. 方案：Schema `extends`

```typescript
// 父 Schema
defineEntity({
  name: 'party',
  label: '参与方',
  abstract: true,           // 不能直接创建 party 记录（可选）
  fields: {
    name: { type: 'string', required: true },
    email: { type: 'string' },
    phone: { type: 'string' },
    address: { type: 'text' },
    type: { type: 'string', system: true },  // 鉴别列，框架自动管理
  },
})

// 子 Schema
defineEntity({
  name: 'customer',
  extends: 'party',          // 继承 party 的所有字段
  fields: {
    // 继承: name, email, phone, address, type
    // 新增:
    credit_limit: { type: 'number', default: 0 },
    payment_terms: { type: 'string', enum: ['net_30', 'net_60', 'net_90'] },
    loyalty_tier: { type: 'string', enum: ['bronze', 'silver', 'gold'] },
  },
})

defineEntity({
  name: 'supplier',
  extends: 'party',
  fields: {
    // 继承: name, email, phone, address, type
    // 新增:
    tax_id: { type: 'string' },
    lead_time_days: { type: 'number' },
    rating: { type: 'number' },
  },
})
```

## 4. 继承规则

### 4.1 字段继承

- 子 Schema 自动获得父 Schema 的所有字段
- 子 Schema 可以**覆盖**父字段的非结构属性（label、default、required），但不能改变 type
- 子 Schema 不能**删除**父字段

```typescript
defineEntity({
  name: 'customer',
  extends: 'party',
  fields: {
    // 覆盖父字段的 required
    email: { required: true },   // party 中 email 不 required，customer 中改为 required
    // 新增子字段
    credit_limit: { type: 'number' },
  },
})
```

### 4.2 Action 继承

父 Schema 的 Action 自动适用于子 Schema：

```typescript
// 定义在 party 上的 Action
defineAction({
  name: 'update_contact_info',
  schema: 'party',
  handler: async (input, ctx) => { /* ... */ },
})

// customer 和 supplier 自动拥有 update_contact_info Action
// 子 Schema 可以定义自己的 Action
defineAction({
  name: 'upgrade_loyalty',
  schema: 'customer',     // 仅 customer 有
  handler: async (input, ctx) => { /* ... */ },
})
```

### 4.3 Rule 继承

父 Schema 的 Rule 自动适用于子 Schema：

```typescript
defineRule({
  name: 'party_email_format',
  schema: 'party',               // 适用于所有子 Schema
  trigger: { on: 'action', action: '*' },
  condition: { field: 'email', op: 'matches', value: '^.+@.+$' },
  effect: { type: 'block', message: 'Invalid email format' },
})
```

### 4.4 State 继承

- 如果父 Schema 定义了状态机，子 Schema 默认继承
- 子 Schema 可以扩展状态机（增加状态和迁移），但不能删除父状态机的状态
- 子 Schema 也可以完全覆盖状态机（`state: { override: true, ... }`）

### 4.5 View 继承

父 Schema 的 View 可被子 Schema 继承并扩展：

```typescript
defineView({
  name: 'party_form',
  schema: 'party',
  type: 'form',
  fields: ['name', 'email', 'phone', 'address'],
})

defineView({
  name: 'customer_form',
  schema: 'customer',
  extends: 'party_form',       // 继承父 View 的字段布局
  fields: ['credit_limit', 'payment_terms', 'loyalty_tier'],  // 追加字段
})
```

### 4.6 限制

- **单继承**：一个 Schema 只能 extends 一个父 Schema（多继承用 Interface）
- **最大深度 3 层**：`A → B → C` 可以，`A → B → C → D` 报错。防止过深层级
- **不支持 extends + extends 循环**：启动时检测

## 5. 数据库策略

### 5.1 单表继承（STI）— 默认

所有子 Schema 共用父 Schema 的数据库表，用 `type` 鉴别列区分。

```sql
CREATE TABLE party (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,              -- 'customer' | 'supplier' | 'employee'
  -- 父字段
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  -- customer 字段
  credit_limit NUMERIC,
  payment_terms TEXT,
  loyalty_tier TEXT,
  -- supplier 字段
  tax_id TEXT,
  lead_time_days INTEGER,
  rating NUMERIC,
  -- 系统字段
  tenant_id TEXT NOT NULL,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  _version INTEGER DEFAULT 1
);

CREATE INDEX idx_party_type ON party(type);
```

**优点：**
- 跨层级查询高效（`SELECT * FROM party` 返回所有类型）
- 无需 JOIN
- 简单

**缺点：**
- 子 Schema 独有字段为 nullable（即使 required）
- 字段多时表结构膨胀

**适用：** 子 Schema 差异字段 < 20 个。

### 5.2 表继承（TPT）— 可选

每个子 Schema 独立表，通过外键关联父表。

```sql
CREATE TABLE party (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  tenant_id TEXT NOT NULL,
  -- 系统字段...
);

CREATE TABLE customer (
  id TEXT PRIMARY KEY REFERENCES party(id),
  credit_limit NUMERIC NOT NULL DEFAULT 0,
  payment_terms TEXT,
  loyalty_tier TEXT
);

CREATE TABLE supplier (
  id TEXT PRIMARY KEY REFERENCES party(id),
  tax_id TEXT,
  lead_time_days INTEGER,
  rating NUMERIC
);
```

**优点：**
- 子字段可以有正确的 NOT NULL 约束
- 表结构更清晰

**缺点：**
- 跨层级查询需要 JOIN
- 写入需要两张表

**适用：** 子 Schema 差异大，或字段数量多。

### 5.3 策略选择

```typescript
defineEntity({
  name: 'party',
  abstract: true,
  inheritance: 'STI',            // 'STI'（默认）| 'TPT'
  fields: { /* ... */ },
})
```

**默认 STI**，除非显式指定 TPT。

## 6. 查询行为

### 6.1 查询父 Schema

查询父 Schema 返回所有子记录（多态查询）：

```graphql
query {
  parties {          # 返回 customer + supplier + employee
    id
    name
    type             # 鉴别列
    email
  }
}
```

### 6.2 查询子 Schema

查询子 Schema 仅返回该类型的记录：

```graphql
query {
  customers {        # 仅 customer
    id
    name
    creditLimit      # 子字段
    loyaltyTier
  }
}
```

### 6.3 GraphQL 类型

```graphql
interface Party {
  id: ID!
  name: String!
  email: String
  phone: String
  type: String!
}

type Customer implements Party {
  id: ID!
  name: String!
  email: String!       # customer 中 required
  phone: String
  type: String!
  creditLimit: Float!
  paymentTerms: String
  loyaltyTier: String
}

type Supplier implements Party {
  id: ID!
  name: String!
  email: String
  phone: String
  type: String!
  taxId: String
  leadTimeDays: Int
  rating: Float
}
```

## 7. abstract Schema

```typescript
defineEntity({
  name: 'party',
  abstract: true,       // 不能直接创建 party 记录
  fields: { /* ... */ },
})
```

- `abstract: true` 的 Schema 不生成 `create_party` Action
- 不生成独立的 GraphQL mutation
- 仅作为父 Schema 被继承
- 可选：非 abstract 的父 Schema 也允许（如 `document` 可以直接创建通用文档）

## 8. 与 Ontology 集成（spec 43）

EntityDescriptor 增加继承信息：

```typescript
interface EntityDescriptor {
  // ...existing...
  parent: string | null              // 父 Schema 名称
  children: string[]                 // 子 Schema 名称列表
  abstract: boolean
  inheritanceStrategy: 'STI' | 'TPT'
  interfaces: InterfaceDefinition[]  // spec 47
}
```

AI 可以查询继承层级：

```typescript
ontology.describe('party')
// { parent: null, children: ['customer', 'supplier', 'employee'], abstract: true }

ontology.describe('customer')
// { parent: 'party', children: [], abstract: false }
```

## 9. 与其他 Spec 的关系

| Spec | 关系 |
|------|------|
| 03_schema | 继承是 EntityDefinition 的扩展（`extends`、`abstract`、`inheritance`） |
| 04_action | 子 Schema 继承父 Schema 的 Action |
| 05_rule | 子 Schema 继承父 Schema 的 Rule |
| 06_state | 子 Schema 可继承或覆盖父状态机 |
| 13_view_and_ui | View 支持 `extends` 继承父 View |
| 43_ontology_layer | Ontology 展示继承层级 |
| 46_link_type | Link 可以指向父 Schema（多态关联） |
| 47_schema_interface | Interface = HAS-A，继承 = IS-A，可组合 |

## 10. 不做什么

- **不做多继承** — 单继承 + Interface 组合已足够
- **不做菱形继承** — 单继承不存在菱形问题
- **不做运行时动态继承** — 继承关系在启动时静态解析
- **不做混合 STI/TPT** — 一个继承树只能用一种策略
- **不超过 3 层** — 过深的继承层级说明需要重新设计

## 11. 里程碑

### M3
- `extends` 声明 + 字段继承
- `abstract` Schema
- STI 数据库策略（默认）
- GraphQL interface 类型生成
- 跨层级查询（查父 Schema 返回所有子记录）
- Action / Rule 继承
- 启动时验证（循环检测、深度检查、字段冲突）

### M4
- TPT 数据库策略
- View 继承（`extends` 父 View）
- 多态 Link（Link 指向父 Schema，实际关联到子记录）
- State 继承与扩展
