# 已有系统改造与迁移设计规范

## 1. 定位

LinchKit 不只是从零开始构建系统，也要能**逐步接管和改造已有系统**。

采用绞杀者模式（Strangler Fig）— 不是一次性替换，而是逐步接管。

## 2. Capability 类型扩展

新增 `adapter` 类型：

| 类型 | 用途 |
|------|------|
| `standard` | 原生 LinchKit 模块 |
| `bridge` | 连接两个模块 |
| `adapter` | 接管/代理已有系统 |

```typescript
import { defineCapability } from '@linchkit/core'

export default defineCapability({
  name: 'legacy_purchase_adapter',
  version: '1.0.0',
  type: 'adapter',

  source: {
    type: 'database',                      // 'database' | 'api'
    connection: '$config.legacy_db_url',   // 配置引用
  },
})
```

## 3. 模式 A：接管已有数据库

### 3.1 数据库 Introspect

从已有数据库自动生成 Schema 定义：

```typescript
import { introspectDatabase } from '@linchkit/migrate'

const schemas = await introspectDatabase({
  connection: 'postgres://...',
  tables: ['purchase_orders', 'purchase_items', 'departments'],
  inferRelations: true,   // 通过外键自动推断关联
})
// → 自动生成 schema/*.ts 文件
```

生成的 Schema 可以手动调整（改字段名、加 label、标记 state 字段等）。

### 3.2 Change Data Capture（CDC）

监听已有数据库的变化，让 LinchKit 感知外部应用的操作：

```typescript
import { defineChangeCapture } from '@linchkit/migrate'

export const cdc = defineChangeCapture({
  source: 'postgres',
  tables: ['purchase_orders'],

  onInsert: (record) => ctx.emit('external.record_created', record),
  onUpdate: (before, after) => ctx.emit('external.record_updated', { before, after }),
  onDelete: (record) => ctx.emit('external.record_deleted', record),
})
```

实现方式：
- PostgreSQL：LISTEN/NOTIFY 或逻辑复制（logical replication）
- 轻量方案：定时轮询 + updated_at 比较

### 3.3 共存期间的数据一致性

LinchKit 和原有应用共享同一个数据库时：
- 原应用直接写库 → CDC 捕获变化 → LinchKit Event 记录
- LinchKit 通过 Action 写库 → 走完整治理链路
- 两者写同一张表，用乐观锁（_version）防冲突

## 4. 模式 B：代理已有 API

### 4.1 External Action

把外部 API 包装成 LinchKit Action：

```typescript
import { defineExternalAction } from '@linchkit/core'

export const createOrder = defineExternalAction({
  name: 'create_order',
  label: '创建订单',

  input: {
    product_id: { type: 'string', required: true },
    quantity: { type: 'number', required: true },
  },

  // 实际调用外部 API
  endpoint: {
    method: 'POST',
    url: 'https://old-system.internal/api/orders',
    headers: {
      Authorization: 'Bearer $config.old_system_token',
    },
    // 输入映射（LinchKit 格式 → 外部 API 格式）
    mapInput: (input) => ({
      product: input.product_id,
      qty: input.quantity,
    }),
    // 输出映射（外部 API 响应 → LinchKit 格式）
    mapOutput: (response) => ({
      order_id: response.data.id,
    }),
  },

  policy: {
    mode: 'sync',
    transaction: false,    // 外部 API 不在 LinchKit 事务内
  },
})
```

### 4.2 External Action 的治理

虽然实际执行在外部系统，但 LinchKit 仍然提供：
- Rule 校验（调用外部 API 之前）
- Event 记录（调用前后都记录）
- 权限控制（谁能调用）
- Execution Log（完整审计）

```
请求进来 → 权限检查 → Rule 评估 → 调用外部 API → 记录 Event → 返回结果
```

### 4.3 逐步迁移

External Action 可以随时替换为内部实现，外部调用方无感：

```typescript
// 阶段 1：代理外部 API
export const createOrder = defineExternalAction({
  endpoint: { url: 'https://old-system/api/orders', ... },
})

// 阶段 2：迁移为内部实现（只需要改定义，调用方不变）
export const createOrder = defineAction({
  handler: async (ctx) => {
    // 内部实现
  },
})
```

## 5. 改造路径

```
阶段 1：接入
  ├── introspect 已有数据库 → 生成 adapter Capability
  ├── 或 接入已有 API → 定义 External Action
  ├── 数据可查（GraphQL）
  └── 可展示（自动生成 View）

阶段 2：治理
  ├── 定义 State Machine（纳入状态管理）
  ├── 定义 Rule（加业务规则）
  ├── 加 Event 记录 + CDC
  └── 原系统继续跑，LinchKit 开始监管

阶段 3：迁移
  ├── 写操作逐步迁移到 Action
  ├── 新功能直接在 LinchKit 上开发
  └── 原系统逐步退役

阶段 4：原生
  ├── adapter → standard
  └── 完全由 LinchKit 管理
```

## 6. 迁移工具

| 工具 | 作用 |
|------|------|
| `introspectDatabase` | 从已有 DB 生成 Schema 定义 |
| `defineChangeCapture` | 监听已有 DB 变化 |
| `defineExternalAction` | 包装外部 API 为 Action |
| `dataMigrate` | 数据迁移工具（旧表 → 新表） |
| `validateMigration` | 验证迁移后数据一致性 |

## 7. 与里程碑的关系

### M0
- 不涉及迁移

### M1
- `introspectDatabase` 基础实现
- `defineExternalAction` 基础实现

### M2
- CDC（Change Data Capture）
- 数据迁移工具

### M3
- AI 辅助分析已有系统，自动生成 adapter Capability
- AI 建议迁移策略
