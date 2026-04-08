# 运行时变更机制

> Tracking milestones:
> - foundational runtime architecture reference
>
> Related issues:
> - No dedicated open issue is currently tracked for this spec.
>
> Execution source of truth: GitHub milestones and issues.

> 本文说明三层 Source of Truth 与运行模式；共享数据库蓝绿发布的兼容性协议见 `38_release_compatibility.md`。

## 1. Source of Truth 三层模型

LinchKit 的定义来源分三层，从低到高依次覆盖：

| 层 | 名称 | 存储位置 | 变更方式 | 说明 |
|----|------|---------|---------|------|
| **Layer 0** | Design-time | TS 文件 / Git | Proposal → PR → 蓝绿部署 | 不可变基线，所有 Capability 定义的根 |
| **Layer 1** | Deploy-time | 环境变量 / 配置文件 | 修改配置 + 重启/部署 | 覆盖配置值（阈值、连接串等），不能改结构 |
| **Layer 2** | Runtime | tenant_overrides 表 (DB) | 租户自助 UI → 写 DB → 刷新缓存 | 仅 SaaS 模式，只能覆盖 Layer 0 中标记为 `overridable: true` 的定义 |

**关键约束**：
- **Layer 2 的覆盖范围必须在 Layer 0 中声明。** 一个 Rule 的阈值能被租户覆盖，前提是该 Rule 定义时标记了 `overridable: true`。
- **Git 始终是"覆盖边界的 source of truth"**：它决定了哪些东西可以被运行时覆盖。`git checkout` + Layer 0 定义可以完整描述系统的所有可能状态。
- **tenant_overrides 是"覆盖值的 source of truth"**：它记录了每个租户实际使用的覆盖值。

```typescript
// Layer 0 示例：在 Rule 定义中声明可覆盖
defineRule({
  name: 'amount_check',
  overridable: true,           // 允许租户覆盖此 Rule 的 condition
  condition: { field: 'target.amount', operator: 'gt', value: 10000 },
  effect: { type: 'require_approval', level: 'director' },
})

// Layer 2 示例：租户 A 覆盖阈值为 50000
// tenant_overrides 表中：
// { tenant_id: 'A', type: 'rule', target: 'amount_check', definition: { condition: { value: 50000 } } }
```

## 2. 运行模式

| 模式 | Layer 0 | Layer 1 | Layer 2 | 变更方式 |
|------|---------|---------|---------|---------|
| **Standalone** | TS 文件 / Git | 环境变量 | tenants/ 目录下的 TS 文件（也走 PR） | 全部走 PR + 蓝绿部署 |
| **SaaS** | TS 文件 / Git | 环境变量 | 数据库（tenant_overrides） | 平台走 PR，租户自助走 DB 热生效 |

### Standalone 模式

Layer 0 + Layer 1 + Layer 2（tenants/ 目录）全部在 Git 中，变更通过蓝绿部署生效。

### SaaS 模式

Layer 0 + Layer 1 在 Git 中。Layer 2 在数据库中，租户自助变更写 DB 后刷新内存缓存立即生效。详见 30_multi_tenancy.md。

## 3. 蓝绿部署方案

### 3.1 架构

```
Load Balancer / Router
    ├── System A (当前版本，正在服务)
    └── System B (新版本，待切换)
共享：PostgreSQL（业务数据）
```

两个实例共享同一个 Postgres 数据库（业务数据），但各自加载自己版本的能力定义。

### 3.2 变更流程

```
1. Proposal — 变更草案（AI 生成或人工编写）
       ↓
2. 生成/修改 TS 文件 — 变更落地为代码
       ↓
3. Validate — 构建时静态检查 + 测试
       ↓
4. Approve — 人工确认（查看 diff）
       ↓
5. Commit to Git — 所有变更有完整历史
       ↓
6. Build — 构建新版本
       ↓
7. Blue-Green Deploy:
   a. 启动新实例（加载新定义）
   b. 健康检查通过
   c. 流量切到新实例
   d. 旧实例保留（可回滚）
```

### 3.3 时间预估

- AI 生成 TS 文件：即时
- 构建（Bun）：< 1 秒
- 启动新实例：1-2 秒
- 健康检查 + 切换：1-2 秒
- **总计：3-5 秒，接近热更新体验**

### 3.4 回滚

回滚 = 把流量切回上一个版本的实例。

- 如果旧实例还在运行：直接切流量，秒级回滚
- 如果旧实例已下线：从上一个 Git 版本重新构建部署

## 4. 好处

1. **分层 source of truth** — Git 定义基线和覆盖边界，DB 只存租户覆盖值
2. **完整变更历史** — Git log 就是变更审计日志
3. **安全** — 构建不通过就不部署，Validation 在构建阶段完成
4. **回滚简单** — 切回上一个实例，或 git revert + 重新部署
5. **声明式和代码式统一处理** — 不需要区分"能热更新"和"需要部署"，所有变更走同一条路
6. **与现代 CI/CD 一致** — 开发者已经熟悉这个模式

## 5. 需要解决的问题

### 5.1 Schema 变更导致的数据库迁移

Schema 加字段、改约束，需要 DB migration。

流程：
- 构建时自动生成 migration（Drizzle Kit）
- 部署新实例前先执行 migration
- migration 必须向后兼容（旧实例还在运行时不能破坏它）

### 5.2 长事务 / 正在执行的 Action

切换流量时，旧实例可能还有正在执行的 Action。

策略：
- 切换流量后，旧实例不再接受新请求
- 等待旧实例上正在执行的 Action 完成（graceful shutdown）
- 设置超时，超时后强制关闭

### 5.3 开发环境

开发时不需要蓝绿部署。直接：
- 修改 TS 文件
- 重启开发服务器（或 hot reload）
- 看效果

蓝绿部署只用于 staging / production 环境。

## 6. 与里程碑的关系

- **M0** — 开发时直接重启，不需要蓝绿
- **M1** — 实现基础蓝绿部署 + Proposal → Git → Build → Deploy 流程
- **M2** — AI 参与 Proposal 生成，自动化程度提升
