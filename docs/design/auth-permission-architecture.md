# 认证与权限架构分析

## 1. 基座 vs Capability 的边界

### 1.1 框架内核（@linchkit/core）必须提供的（不可替换）

| 概念 | 说明 |
|------|------|
| `Actor` 接口定义 | `Actor { type, id, name, roles, metadata }` — 这是类型契约，不是实现 |
| `ctx.actor` | ActionContext 上的 actor 属性，所有引擎都依赖它 |
| Pipeline slot 机制 | `auth` / `permission` / `tenant` 等插槽的注册和调度机制 |
| Permission 声明语法 | Action 定义里的 `permissions: { roles, actorTypes }` 字段解析 |
| `getCurrentActor()` 抽象 | 从请求上下文中获取当前 Actor 的函数签名 |
| `canAccess()` 抽象 | 权限检查的函数签名（返回 boolean + reason） |
| 匿名 Actor 降级 | 当 cap-auth 未安装时，注入一个 `{ type: 'system', id: 'anonymous', roles: [] }` |

**核心原则：core 定义接口和契约，不提供任何具体的认证/授权实现。**

当 cap-auth 未安装时，系统以匿名模式运行（所有请求的 actor 是 anonymous）。当 cap-permission 未安装时，所有权限检查跳过（无访问控制）。这与 spec 16 中 Command Layer 的设计一致："未安装则跳过"。

### 1.2 系统 Capability 提供的（可替换）

| Capability | 职责 |
|------------|------|
| `cap-auth` | 认证实现：JWT 签发/验证、session 管理、login/logout Action、用户生命周期 |
| `cap-permission` | 授权实现：权限组 CRUD、权限矩阵计算、数据权限过滤、"我能干啥"视图 |

### 1.3 Actor/Session 属于哪一层

- **Actor 接口** → core 层（类型定义 + ctx.actor 注入点）
- **Actor 实例化**（从 JWT 解析出 Actor）→ cap-auth（填充 auth slot）
- **Session/Token 管理** → cap-auth
- **Actor 的权限计算** → cap-permission

Actor 是横跨两层的概念：core 定义"Actor 是什么"，cap-auth 决定"Actor 从哪来"。

## 2. Account（认证）和 Permission（授权）是否应该分离

**结论：分离。`cap-auth` + `cap-permission` 两个独立 Capability。**

### 2.1 分离的理由

| 维度 | cap-auth（认证） | cap-permission（授权） |
|------|-----------------|----------------------|
| 核心问题 | "你是谁" | "你能干什么" |
| Schema | user, session, token | permission_group, permission |
| Action | login, logout, refresh_token, reset_password | create_group, assign_user, revoke_user |
| Pipeline slot | auth（Token 验证 → ctx.actor） | permission（权限检查） |
| 替换场景 | 换成 OAuth/OIDC/LDAP | 换成 ABAC/自定义权限模型 |
| View | 登录页、个人设置 | 权限矩阵、"我能干啥"、模拟用户 |

### 2.2 对比 Odoo 模式

Odoo 的实现：
- `res.users` — 用户表（认证 + 基础信息）
- `res.groups` — 权限组
- `ir.rule` — 数据权限（行级过滤）
- `ir.model.access` — 对象级权限

LinchKit 的映射：
- `cap-auth` ≈ `res.users` + session 管理
- `cap-permission` ≈ `res.groups` + `ir.rule` + `ir.model.access`

Odoo 的 users 和 groups 虽然在同一个模块（base）里，但逻辑上是分离的。LinchKit 选择包级分离更合理，因为：
1. 替换认证方式（换 OAuth Provider）不应该影响权限模型
2. 纯 API 服务可能用 API Key 认证但仍需完整权限控制
3. 开发阶段可以只装 cap-auth 跳过权限（快速验证）

### 2.3 不做 cap-account 的理由

合并成 cap-account 会导致：
- 替换粒度太大（换认证方式时连权限模型一起换了）
- 违反单一职责
- 与 spec 14 已有设计不一致（已明确分成两个）

### 2.4 依赖关系

```
cap-permission 强依赖 cap-auth
  （权限检查需要知道"谁"→ 需要 auth 提供 Actor）

cap-auth 不依赖 cap-permission
  （认证本身不需要授权，用户登录是公开操作）
```

## 3. 框架基座需要提供什么

### 3.1 core 提供的抽象

```typescript
// === types/actor.ts ===
interface Actor {
  type: 'human' | 'ai' | 'system' | 'worker' | 'timer' | 'external'
  id: string
  name?: string
  roles: string[]
  metadata?: Record<string, unknown>
}

// === types/permission.ts ===
interface PermissionCheck {
  allowed: boolean
  reason?: string  // "为什么不能"诊断用
}

// === types/pipeline.ts ===
// Pipeline slot 注册接口
interface PipelineSlot {
  name: 'pre' | 'auth' | 'exposure' | 'permission' | 'tenant' | 'pre-action' | 'post-action'
  handler: (ctx: RequestContext) => Promise<void>
  priority?: number
}
```

### 3.2 core 内置的默认行为

| 场景 | 默认行为（无 Capability 时） |
|------|--------------------------|
| auth slot 为空 | 注入匿名 Actor `{ type: 'system', id: 'anonymous', roles: [] }` |
| permission slot 为空 | 跳过权限检查，所有操作允许 |
| tenant slot 为空 | 单租户模式，不注入 tenantId |

### 3.3 cap-auth 提供的实现

```
填充 auth slot：
  HTTP → 从 Authorization: Bearer <token> 解析 JWT → 构造 Actor → ctx.actor
  MCP  → 从 apiKey 查找 Actor → ctx.actor
  CLI  → 从本地 token 文件读取 → ctx.actor

Schema: user, session
Action: login, logout, refresh_token
State: user_lifecycle (active / disabled / locked)
```

### 3.4 cap-permission 提供的实现

```
填充 permission slot：
  读取 ctx.actor.roles → 查询权限组 → 检查当前 Action 是否允许 → 通过/拒绝

Schema: permission_group, permission
Action: create_group, assign_user, revoke_user, update_permissions
View: permission_matrix, user_permissions, simulate_user

运行时扩展：
  - ctx.query/ctx.get 自动附加数据权限过滤条件
  - GraphQL 查询自动应用行级权限
```

## 4. M0b 阶段的最小实现

根据 README 中 M0b 的 scope："cap-auth + cap-permission + pipeline slots + login + access control"，以下是推荐的最小实现：

### 4.1 Pipeline 基础（core 层，必须做）

- [ ] Pipeline slot 注册机制（`registerSlot(name, handler)`）
- [ ] Pipeline 执行顺序：pre → auth → exposure → permission → tenant → pre-action → action → post-action
- [ ] 默认行为：slot 未填充时的降级逻辑（匿名/跳过）
- [ ] `ctx.actor` 在 ActionContext 中可用

### 4.2 cap-auth（最小认证）

- [ ] Schema: `user` (id, email, password_hash, name, status, roles)
- [ ] Action: `login` (email + password → JWT token)
- [ ] Action: `logout` (清除 session)
- [ ] JWT 签发与验证（简单 HS256，不需要 refresh token）
- [ ] auth slot 中间件：解析 Bearer token → ctx.actor
- [ ] 内置 admin 用户（seed 数据，首次启动自动创建）
- [ ] **不做**：注册、OAuth、LDAP、密码重置、MFA

### 4.3 cap-permission（最小授权）

- [ ] Schema: `permission_group` (name, label, permissions JSONB)
- [ ] 内置权限组：`admin`（全部权限）、`user`（基础权限）
- [ ] 权限检查中间件：填充 permission slot
- [ ] Action 级权限检查（`action.permissions.roles` 匹配 `actor.roles`）
- [ ] **不做**：数据权限（行级）、字段级权限、权限矩阵 UI、模拟用户、AI 约束

### 4.4 M0b 不做的

| 功能 | 推迟到 |
|------|--------|
| 数据权限（行级过滤） | M1 |
| 字段级权限 | M2 |
| AI Permission Group + 速率限制 | M1 |
| "我能干啥"视图 / "为什么不能"诊断 | M1 |
| 模拟用户 | M1 |
| OAuth / LDAP / 第三方认证 | M2+ |
| Refresh Token 机制 | M1 |
| 权限组 CRUD UI | M1 |

### 4.5 M0b 的 Actor 策略

**不硬编码 admin actor。** 而是：
1. 首次启动时 seed 一个 admin 用户（email: admin@localhost, 默认密码）
2. admin 用户属于 admin 权限组
3. 通过 login Action 获取 JWT
4. 后续请求带 Bearer token

这样从 M0b 开始就走完整的认证流程，避免以后替换硬编码逻辑。

## 5. 与状态机/Action/Rule 的关系

### 5.1 Action.permissions 的解析

Action 定义中的 `permissions` 字段是声明式的：

```typescript
defineAction({
  name: 'approve_request',
  permissions: {
    roles: ['purchase_approver', 'admin'],
    actorTypes: ['human'],  // AI 不能审批
  },
})
```

**解析职责划分：**
- core 负责解析 `permissions` 字段定义
- cap-permission 的 pipeline 中间件负责实际检查：读取 `action.permissions` + `actor.roles` → 判断是否允许

**如果 cap-permission 未安装：** `permissions` 字段被忽略，所有操作允许。这是设计意图 — 开发阶段可以无权限控制快速迭代。

### 5.2 Rule 与 requireApproval

Rule 的 `requireApproval` effect 依赖权限系统来确定"谁有权审批"：

```typescript
defineRule({
  effects: [{ type: 'requireApproval', approvers: { roles: ['cfo'] } }]
})
```

这里的 `approvers.roles` 需要 cap-permission 来解析"哪些用户属于 cfo 角色"。M0b 阶段 requireApproval 功能不在 scope 内（Proposal 系统是 M1），所以不影响 M0b 实现。

### 5.3 执行时序确认

```
请求进入 Command Layer
  → [auth slot]       cap-auth:        JWT 验证 → ctx.actor
  → [exposure slot]   core:            接口暴露检查
  → [permission slot] cap-permission:  权限检查（action 级）
  → 输入校验（Zod）
  → 前置校验（validate）
  → Rule 评估（Rule Engine，独立于权限）
  → 事务 + 执行
```

权限检查在 Rule 评估之前。权限不够直接 403，不进入 Rule 流程。Rule 是业务规则（"金额 > 5 万需要 CFO 审批"），权限是访问控制（"你有没有资格调这个 Action"）。两者正交。

## 6. 推荐架构总结

```
@linchkit/core（不可替换）
  ├── Actor 接口定义
  ├── PermissionCheck 接口定义
  ├── Pipeline slot 机制（注册 + 调度）
  ├── Action.permissions 字段解析
  ├── 默认降级行为（匿名 Actor / 跳过权限）
  └── ctx.actor 注入点

@linchkit/cap-auth（可替换，M0b 实现）
  ├── user Schema + seed admin
  ├── login / logout Action
  ├── JWT 签发/验证
  └── 填充 auth slot

@linchkit/cap-permission（可替换，M0b 实现）
  ├── permission_group Schema
  ├── 内置 admin / user 权限组
  ├── Action 级权限检查
  └── 填充 permission slot

未来可替换示例：
  @linchkit/cap-auth-oidc    → 替换 cap-auth，用 OIDC 认证
  @linchkit/cap-auth-ldap    → 替换 cap-auth，用 LDAP 认证
  @my-company/cap-permission → 替换 cap-permission，用自定义 ABAC 模型
```

## 7. M0b Action Items

按优先级排序：

1. **core: Pipeline slot 机制** — 注册接口 + 执行调度 + 默认降级
2. **core: Actor 接口** — 类型定义 + ctx.actor 属性
3. **core: PermissionCheck 接口** — canAccess 函数签名
4. **cap-auth: user Schema + JWT** — 最小用户模型 + 认证
5. **cap-auth: login/logout Action** — 认证入口
6. **cap-auth: auth slot 中间件** — Bearer token 解析
7. **cap-permission: permission_group Schema** — 权限组数据模型
8. **cap-permission: 内置权限组 seed** — admin + user
9. **cap-permission: permission slot 中间件** — Action 级权限检查
10. **集成测试** — 完整 pipeline 跑通：login → 拿 token → 带 token 调 Action → 权限通过/拒绝
