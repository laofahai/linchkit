# 事务模型设计规范

## 1. 三层事务

### 1.1 单动作事务

一个 Action 内的原子性。

```
Action: submit_request
  事务开始
    ├── 校验输入
    ├── Rule 评估
    ├── 状态迁移 (draft → submitted)
    ├── 数据写入
    ├── Event 写入
    ├── Outbox 写入
  事务提交（全部成功）或回滚（任一失败）
```

这是最基本的事务，由 Action Engine 管理。每个 Action 的 policy 中声明 `transaction: true/false`。

已在 04_action.md 中定义。

### 1.2 跨动作事务（Saga）

多个 Action 串联时的一致性。

```
Flow: 采购 → 入库 → 付款

如果"入库"成功但"付款"失败：
  - 不能简单回滚入库（因为入库事务已提交）
  - 需要补偿：执行"取消入库"Action
```

**跨动作不用数据库事务，用 Saga 补偿模式。** 由 Temporal 编排。

```typescript
defineFlow({
  name: 'purchase_to_payment',
  steps: [
    {
      name: 'create_inbound',
      type: 'action',
      action: 'create_inbound',
      compensation: 'cancel_inbound',  // 失败时的补偿 Action
    },
    {
      name: 'create_payment',
      type: 'action',
      action: 'create_payment',
      compensation: 'cancel_payment',
    },
  ],
  // 任一步骤失败，按反序执行已完成步骤的 compensation
  failurePolicy: 'compensate',
})
```

### 1.3 变更事务

一次 Proposal 发布多个定义（Schema + Rule + Action + View）的原子性。

```
Proposal: 新增预算控制功能
  包含：
    - 新增 Rule: budget_check
    - 新增 computed field: department_monthly_total
    - 修改 View: purchase_request_form（加显示预算）
```

这些必须作为一个整体发布，不能只发布了 Rule 但 View 没更新。

**变更事务由部署机制保证：** 一次 Proposal = 一次 Git commit = 一次构建 = 一次蓝绿切换。要么全部生效，要么全部不生效。蓝绿部署天然保证了变更的原子性。

## 2. 一致性模型

### 2.1 强一致（事务内，同步）

| 操作 | 原因 |
|------|------|
| 状态迁移 | 业务真相，不能不一致 |
| 金额计算 | 数字准确性 |
| 权限校验 | 安全性 |
| 核心数据写入 | 数据完整性 |
| Rule 评估 | 裁决必须在操作前完成 |
| 幂等检查 | 防重复 |
| 乐观锁检查 | 防并发冲突 |
| Event 写入 | 事件不能丢 |
| Outbox 写入 | 异步任务不能丢 |

### 2.2 最终一致（事务后，异步）

| 操作 | 原因 |
|------|------|
| 通知推送 | 不影响核心业务 |
| 报表更新 | 可以延迟 |
| 搜索索引更新 | 可以延迟 |
| 关系图更新 | 可以延迟 |
| AI 分析 | 非实时 |
| 文档更新 | 可以延迟 |

## 3. 并发控制

### 3.1 乐观锁

每条记录有 `_version` 字段。更新时检查版本：

```sql
UPDATE purchase_request
SET status = 'approved', _version = _version + 1
WHERE id = 'pr_001' AND _version = 3
```

如果返回 0 行受影响，说明被其他操作并发修改，Action 失败并提示重试。

### 3.2 幂等

每个 Action 支持幂等键：

```typescript
// 调用时传入幂等键
await executeAction('submit_request', { id: 'pr_001' }, {
  idempotencyKey: 'submit-pr001-20260320',
})
```

框架检查该 key 是否已执行过，如果是则直接返回上次结果。

幂等记录存 Postgres，有过期时间（默认 24 小时）。

## 4. 回滚 vs 补偿

| | 回滚 (Rollback) | 补偿 (Compensation) |
|--|------|------|
| 时机 | 事务内失败 | 事务已提交后失败 |
| 机制 | 数据库事务回滚 | 执行反向 Action |
| 范围 | 单 Action 内 | 跨 Action（Saga） |
| 由谁管 | Action Engine + Postgres | Temporal |

**不能混用。** 事务内失败用回滚，跨事务失败用补偿。

## 5. 与里程碑的关系

### M0
- 单动作事务
- 乐观锁
- 基础幂等

### M1
- Saga 补偿（Temporal）
- 变更事务（蓝绿部署原子性）
- 幂等键管理

### M2
- 跨模块 Saga
- 补偿 Action 自动生成建议
