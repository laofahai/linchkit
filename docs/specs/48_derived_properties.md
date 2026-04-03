# Derived Properties — 派生字段

> Status: Draft | Date: 2026-03-23
> 灵感来源: Palantir Foundry Derived Properties
> 里程碑: M3

## 1. 问题

很多字段的值不是用户直接输入的，而是从其他字段或关联数据**计算得出**的。例如：

- 订单总金额 = `sum(order_items.amount)`
- 采购申请是否超预算 = `amount > department.monthly_budget`
- 客户信用评分 = 基于历史订单和回款计算
- 全名 = `last_name + first_name`
- 逾期天数 = `today() - due_date`（仅当 `status = 'overdue'`）

当前做法：
- 在 Action handler 中手动计算并写入字段
- 或在 UI 层用 JS 临时计算

问题：
- **逻辑分散**：计算逻辑散落在各个 Action handler 中
- **不一致**：不同 Action 可能遗漏更新计算字段
- **AI 不可知**：AI 不知道哪些字段是计算的、依赖什么
- **GraphQL 无法直接返回**：临时计算的值不在数据库中

## 2. 方案：Schema 字段声明 `derived`

在 Schema 字段定义中增加 `derived` 选项，声明该字段的计算逻辑。

```typescript
defineEntity({
  name: 'sales_order',
  fields: {
    // 普通字段
    customer_id: { type: 'ref', target: 'customer', required: true },
    status: { type: 'string', enum: ['draft', 'confirmed', 'shipped', 'completed'] },
    created_at: { type: 'datetime' },

    // 派生字段
    total_amount: {
      type: 'number',
      derived: {
        type: 'aggregate',
        source: { link: 'order_to_items', schema: 'order_item' },
        op: 'sum',
        field: 'amount',
      },
    },

    item_count: {
      type: 'number',
      derived: {
        type: 'aggregate',
        source: { link: 'order_to_items', schema: 'order_item' },
        op: 'count',
      },
    },

    is_overbudget: {
      type: 'boolean',
      derived: {
        type: 'expression',
        expr: { gt: ['$total_amount', '$customer.credit_limit'] },
        deps: ['total_amount', 'customer_id'],  // 显式声明依赖
      },
    },

    full_name: {
      type: 'string',
      derived: {
        type: 'concat',
        fields: ['last_name', 'first_name'],
        separator: ' ',
      },
    },

    overdue_days: {
      type: 'number',
      derived: {
        type: 'function',
        compute: (record) => {
          if (record.status !== 'overdue') return 0
          return daysBetween(record.due_date, new Date())
        },
        deps: ['status', 'due_date'],
      },
    },
  },
})
```

## 3. 派生类型

### 3.1 聚合派生（aggregate）

从关联记录聚合计算。

```typescript
derived: {
  type: 'aggregate',
  source: {
    link: string,        // Link 名称（spec 46）
    schema: string,      // 关联 Schema 名称
    filter?: DeclarativeCondition,  // 可选过滤条件
  },
  op: 'sum' | 'count' | 'avg' | 'min' | 'max',
  field?: string,        // 聚合的字段（count 不需要）
}
```

示例：
- `total_amount`: `sum(order_items.amount)`
- `approved_count`: `count(requests where status='approved')`

### 3.2 表达式派生（expression）

基于同一条记录的字段做计算。使用 DeclarativeCondition 语法。

```typescript
derived: {
  type: 'expression',
  expr: ConditionExpression,    // 复用 DeclarativeCondition 语法
  deps: string[],               // 依赖的字段名（触发重算）
}
```

示例：
- `is_overbudget`: `amount > budget_limit`
- `profit`: `revenue - cost`

### 3.3 拼接派生（concat）

多个字符串字段拼接。

```typescript
derived: {
  type: 'concat',
  fields: string[],             // 要拼接的字段名
  separator?: string,           // 分隔符，默认 ''
}
```

### 3.4 函数派生（function）

复杂计算用函数表达。

```typescript
derived: {
  type: 'function',
  compute: (record: Record<string, unknown>) => unknown,
  deps: string[],               // 依赖的字段名
}
```

适用于无法用声明式表达的逻辑（日期差、条件分支等）。

## 4. 计算策略

派生字段有两种计算时机：

### 4.1 写时计算（store）— 默认

在数据写入时计算，结果持久化到数据库。

```typescript
total_amount: {
  type: 'number',
  derived: {
    type: 'aggregate',
    source: { link: 'order_to_items', schema: 'order_item' },
    op: 'sum',
    field: 'amount',
    strategy: 'store',         // 默认
  },
}
```

**触发时机：**
- 当依赖字段被 Action 修改时
- 当关联记录增删改时（aggregate 类型）
- Action Engine 在 post-action 阶段自动重算并更新

**优点：** 查询快（已存在数据库），可被 GraphQL / 过滤 / 排序使用。
**缺点：** 需要额外写入；关联记录变更时需要级联更新。

### 4.2 读时计算（compute）

在查询时动态计算，不持久化。

```typescript
overdue_days: {
  type: 'number',
  derived: {
    type: 'function',
    compute: (record) => daysBetween(record.due_date, new Date()),
    deps: ['due_date'],
    strategy: 'compute',       // 读时计算
  },
}
```

**触发时机：** 每次查询该字段时。

**优点：** 不需要额外写入；始终是最新值。
**缺点：** 不能被数据库排序/过滤；有计算开销。

### 4.3 选择建议

| 场景 | 推荐策略 |
|------|----------|
| 需要排序/过滤的字段 | `store` |
| 聚合计算（sum, count） | `store` |
| 包含「当前时间」的计算 | `compute` |
| 极少被查询的字段 | `compute` |
| 跨大量关联记录的聚合 | `store`（避免每次查询都聚合） |

## 5. 级联更新（store 策略）

当关联记录变更时，需要级联更新依赖它的派生字段：

```
order_item 被修改（amount 变更）
  → 找到依赖 order_item 的 store 类型派生字段
  → 重算 sales_order.total_amount = sum(order_items.amount)
  → 更新 sales_order 记录
```

### 5.1 实现

在 ActionExecutor 的 post-action 阶段：

1. 检查被修改的记录所属 Schema
2. 查找所有通过 Link 关联到此 Schema 的 aggregate 派生字段
3. 对每个受影响的父记录，重新计算派生值
4. 批量更新

### 5.2 循环保护

派生字段 A 依赖 B，B 依赖 A → 启动时报错。

框架在启动时构建依赖图，检测循环。

## 6. GraphQL 集成

派生字段自动出现在 GraphQL 类型中，和普通字段无区别：

```graphql
type SalesOrder {
  id: ID!
  customer: Customer!
  status: String!
  totalAmount: Float!       # 派生字段，透明呈现
  itemCount: Int!           # 派生字段
  isOverbudget: Boolean!    # 派生字段
}
```

- `store` 策略：直接从数据库读取
- `compute` 策略：resolver 中调用 compute 函数

## 7. 与 Ontology 集成（spec 43）

EntityDescriptor 标注哪些字段是派生的：

```typescript
interface FieldInfo {
  field: FieldDefinition
  isDerived: boolean
  derivedType?: 'aggregate' | 'expression' | 'concat' | 'function'
  derivedStrategy?: 'store' | 'compute'
  dependencies?: string[]        // 依赖的字段/Schema
}
```

AI 可以知道：
- 哪些字段是用户输入的 vs 系统计算的
- 派生字段的依赖链（修改 A 会影响哪些派生字段）

## 8. 约束

- 派生字段**不可被 Action 直接写入**（`store` 策略由框架自动写入）
- 派生字段**不参与 Zod 输入校验**（它不是输入）
- 派生字段**可以出现在 View 中**（显示用，不可编辑）
- 派生字段**可以出现在 Rule condition 中**（基于计算值判断）
- `compute` 策略的派生字段**不可用于 GraphQL where 过滤和 orderBy**

## 9. 不做什么

- **不做实时流式计算** — 不是 Kafka Streams / Flink。级联更新是同步的，Action 后触发。
- **不做跨租户派生** — 派生计算始终在同一 tenant_id 范围内。
- **不做复杂 DAG 调度** — 依赖图在启动时解析为拓扑序，按序计算。不做运行时动态调度。
- **不支持窗口函数** — 如「最近 30 天的总金额」需要用 Watcher（spec 45）而非派生字段。

## 10. 与现有 Spec 的关系

| Spec | 关系 |
|------|------|
| 03_schema | 派生字段是 FieldDefinition 的扩展 |
| 04_action | Action Engine post-action 阶段触发 store 策略重算 |
| 13_view_and_ui | View 可以显示派生字段（只读） |
| 43_ontology_layer | Ontology 标注字段的派生元信息 |
| 46_link_type | aggregate 派生字段依赖 Link 定义 |

## 11. 里程碑

### M3
- `derived` 字段定义（expression, concat, function 类型）
- `store` 策略：依赖字段变更时自动重算（同记录内）
- `compute` 策略：GraphQL resolver 中动态计算
- 启动时依赖图构建 + 循环检测
- 派生字段在 GraphQL / View 中透明呈现

### M4
- `aggregate` 派生类型（需要 Link 和级联更新）
- 跨记录级联更新
- 派生字段在 Rule condition 中使用
- MCP 工具展示字段依赖图
