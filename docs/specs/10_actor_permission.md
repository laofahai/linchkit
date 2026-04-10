# Actor 与权限模型设计规范

> Tracking milestones:
> - foundational security architecture reference
>
> Related issues:
> - No dedicated open issue is currently tracked for this spec.
>
> Execution source of truth: GitHub milestones and issues.

> 权限管理本身作为系统内置 Capability 实现，见 14_system_capabilities.md
> 认证机制详见 [10a_authentication.md](10a_authentication.md)

## 1. Actor 模型

### 1.1 定义

Actor 是系统中所有操作的发起者。每次 Action 执行、Proposal 提交、审批操作，都必须有明确的 Actor。

### 1.2 Actor 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `human` | 人类用户 | 张三通过 UI 提交采购单 |
| `ai` | AI 代理 | Claude 通过 MCP 调用 Action |
| `system` | 系统内部 | 框架自动执行的逻辑（如声明式 Action 的自动状态迁移） |
| `worker` | 后台任务 | Outbox Worker 执行异步 EventHandler |
| `timer` | 定时任务 | cron 触发的定时检查 |
| `external` | 外部系统 | 第三方系统通过 API 调用 |

### 1.3 Actor 结构

```typescript
interface Actor {
  type: 'human' | 'ai' | 'system' | 'worker' | 'timer' | 'external'
  id: string              // 唯一标识
  name?: string           // 显示名
  groups: string[]        // 权限组列表（不叫 roles，避免与传统 RBAC 混淆）
  metadata?: object       // 附加信息（如 AI 的 model、external 的 system_name）
}
```

### 1.4 Actor 在事件链中的追踪

```
Actor: 张三 (human)
  → 触发 submit_request
    → 触发 Rule 评估 (Actor: system)
    → 触发 EventHandler: notify_approver (Actor: worker)
      → 触发 send_notification (Actor: worker, caused_by: 张三)
```

所有后续操作都能追溯到原始 Actor。

## 2. 权限模型

### 2.1 权限组（替代传统 RBAC 的"角色"）

不叫"角色"，叫"权限组"。按 Capability 组织权限，更直观。

#### API Design Principles

1. **Object-style for storage** — definitions must serialize to JSONB (DB is truth)
2. **Chain-style for discovery** — IDE-guided builder with `.build()` producing same objects
3. **Category for UI grouping** — Admin UI groups permission groups by category
4. **Implies for inheritance** — Manager implies User (like Odoo `implied_ids`)

> **Status: Planned (M5)** — The `grant`, `category`, `implies` fields and `permissionGroup()` builder shown below are the planned API. The current implementation uses `definePermissionGroup()` with a 3-level `permissions: Record<capability, Record<entity, SchemaPermissions>>` structure. Examples below show the target design.

#### Object Style (direct, AI-friendly, matches DB)

```typescript
import { definePermissionGroup, allowActions, ownRecords, readAll } from '@linchkit/core'

export const purchaseUser = definePermissionGroup({
  name: 'purchase_user',
  label: '采购用户',
  category: 'purchase_management',
  implies: ['base_user'],

  grant: {
    purchase_request: {
      actions: allowActions('create_request', 'submit_request'),
      data: ownRecords(),           // read + write own records (created_by = $actor.id)
    },
  },
})

export const purchaseManager = definePermissionGroup({
  name: 'purchase_manager',
  label: '采购管理员',
  category: 'purchase_management',
  implies: ['purchase_user'],       // Inherits user's create/submit + own records

  grant: {
    purchase_request: {
      actions: allowActions('approve_request', 'reject_request'),
      data: readAll(),              // Override: can read all records
    },
  },
})
```

**Note:** `grant` replaces the old `permissions` key. Old structure was `permissions[capability][entity]` — 3 levels of nesting. New `grant` maps entity names directly — capability resolution is automatic.

> **Migration note:** Legacy examples elsewhere in this spec still use the `permissions[capability][entity]` structure. The planned API uses `grant` (see above). Both are documented for reference during migration.

#### Chain Style (IDE-guided, semantic, discoverable)

```typescript
import { permissionGroup } from '@linchkit/core'

export const purchaseManager = permissionGroup('purchase_manager')
  .label('采购管理员')
  .category('purchase_management')
  .implies('purchase_user')
  .on('purchase_request')
    .allow('approve_request', 'reject_request')
    .readAll()
  .build()
// → produces the same PermissionGroupDefinition plain object
```

**Object-style = "fill-in-the-blank"** — you need to know the type structure.
**Chain-style = "multiple-choice"** — each step tells you what's next.

Both will produce the same JSONB-serializable `PermissionGroupDefinition`.

#### Helper Functions Reference

| Helper | Expands to |
|--------|-----------|
| `allowActions('a', 'b')` | `{ a: true, b: true }` |
| `denyActions('a')` | `{ a: false }` |
| `ownRecords(field = 'created_by')` | `{ read: { condition: { field, op: 'eq', value: '$actor.id' } }, write: same }` |
| `readAll()` | `{ read: 'all' }` |
| `fullAccess()` | `{ read: 'all', write: 'all' }` |
| `noAccess()` | `{ read: 'none', write: 'none' }` |

#### Implies Resolution

```
purchase_manager → implies: purchase_user → implies: base_user
Merge order: base_user → purchase_user → purchase_manager
Strategy: explicit-deny-wins (same as §7.1)
```

#### Category in Admin UI

```
┌─ 采购管理 (purchase_management) ──────────┐
│  ☑ purchase_user      采购用户             │
│  ☑ purchase_manager   采购管理员           │
├─ 库存管理 (inventory_management) ─────────┤
│  ☐ inventory_user     库存用户             │
└────────────────────────────────────────────┘
```

### 2.2 权限层次

| 权限类型 | 说明 |
|----------|------|
| `action` | 能否执行某个 Action |
| `read` | 能否读取某个 Schema 的数据 |
| `read.fields` | 能读哪些字段（字段级权限） |
| `proposal.create` | 能否提交 Proposal |
| `proposal.approve` | 能否审批 Proposal |
| `version.release` | 能否发布版本 |
| `version.rollback` | 能否回滚版本 |

### 2.3 解决"权限难用"的三个关键功能

#### "我能干啥" 视图

给每个用户一个页面，直接展示他能操作的所有 Action，按 Capability 分组：

```
张三的权限：

采购管理
  ✅ 创建采购申请
  ✅ 提交采购申请
  ✅ 审批采购申请
  ❌ 确认采购

库存管理
  ✅ 查看库存
  ❌ 创建入库单
```

#### "为什么不能" 诊断

用户点了灰色按钮，系统直接告诉原因：

```
你不能执行"确认采购"，原因：
  - 你没有 purchase_management.confirm_purchase 权限
  - 需要联系管理员添加权限
```

#### "模拟用户" 能力

管理员可以选一个用户，看到他的视角 — 能看到什么、能操作什么。排查权限问题极其有用。

### 2.4 AI 的特殊权限约束

```typescript
export const aiAgent = definePermissionGroup({
  name: 'ai_agent',
  label: 'AI 代理',

  permissions: {
    purchase_management: {
      actions: {
        create_request: true,
        submit_request: true,
        approve_request: false,    // AI 不能审批
      },
    },
  },

  // AI 专属限制
  constraints: {
    requireHumanApproval: ['proposal.create'],
    rateLimit: { maxActionsPerMinute: 60 },
    auditLevel: 'full',
  },
})
```

### 2.4 权限检查时机

```
Action 请求进来
    ↓
1. 身份认证 — 确认 Actor 是谁
    ↓
2. 权限检查 — Actor 是否有权限执行此 Action
    ↓
3. 数据权限 — Actor 是否有权限操作此条记录（如"只能操作自己的"）
    ↓
4. 继续执行 Action（Rule 评估等）
```

权限检查在 Rule 评估之前。权限不够直接拒绝，不进入 Rule 流程。

### 2.5 system_admin 定义

`system_admin` 是一个特殊的权限组，具有以下特性：

- 拥有所有 Capability 的所有 Action 权限
- 可以跨 tenant 操作（SaaS 模式下）
- 不受 DataAccess 行级过滤限制
- 可以模拟任何用户的权限视角

```typescript
export const systemAdmin = definePermissionGroup({
  name: 'system_admin',
  label: '系统管理员',
  description: '拥有所有权限的超级管理员',
  permissions: {}, // 空 = 所有权限（特殊处理）
  constraints: {
    auditLevel: 'full', // 所有操作必须记录
  },
})
```

**注意**：`system_admin` 是权限组，不是 Actor 类型。任何 Actor 类型（human、ai 等）都可以属于此权限组，但 AI 类型的 Actor 即使属于 system_admin 组，仍受 `requireHumanApproval` 约束。

### 2.6 Permission Group 分配

权限组通过 cap-permission Capability 管理：

```typescript
// 分配用户到权限组
await ctx.executeAction('assign_permission_group', {
  actor_id: 'user_001',
  group: 'purchase_approver',
})

// 移除用户的权限组
await ctx.executeAction('remove_permission_group', {
  actor_id: 'user_001',
  group: 'purchase_approver',
})
```

权限组信息存储在用户记录中，登录时加载到 JWT claims 的 `groups[]` 字段。

## 3. 数据权限（行级）

除了"能不能调 Action"，还需要控制"能操作哪些数据"。

```typescript
// 数据权限规则
export const staffDataAccess = defineDataAccess({
  group: 'staff',
  schema: 'purchase_request',

  // 读：只能看自己部门的
  read: {
    condition: { field: 'department', operator: 'eq', value: '$actor.department' },
  },

  // 写：只能改自己创建的
  write: {
    condition: { field: 'created_by', operator: 'eq', value: '$actor.id' },
  },
})
```

数据权限在 ctx.get / ctx.query 时自动附加，开发者不需要在 Action handler 里手动过滤。

### 3.1 变量解析

DataAccess 条件中支持以下变量：

| 变量 | 解析为 | 示例 |
|------|--------|------|
| `$actor.id` | 当前 Actor 的 ID | `{ field: 'created_by', operator: 'eq', value: '$actor.id' }` |
| `$actor.groups` | 当前 Actor 的权限组列表 | 用于 `in` 操作符 |
| `$actor.metadata.*` | Actor 元数据的任意字段 | `$actor.metadata.department` |
| `$tenant.id` | 当前租户 ID | 自动附加，无需手动使用 |

变量在 ActionExecutor 执行权限检查时解析，替换为实际值后作为查询条件附加到数据访问层。

```typescript
// 解析示例
function resolveVariable(variable: string, ctx: CommandContext): unknown {
  if (variable === '$actor.id') return ctx.actor.id
  if (variable === '$actor.groups') return ctx.actor.groups
  if (variable.startsWith('$actor.metadata.')) {
    const key = variable.slice('$actor.metadata.'.length)
    return ctx.actor.metadata?.[key]
  }
  if (variable === '$tenant.id') return ctx.tenantId
  throw new Error(`Unknown variable: ${variable}`)
}
```

## 4. 与 Capability 的关系

权限定义属于哪里？

- **通用权限组**（admin、staff）→ 系统级定义
- **业务权限组**（采购经理、仓库管理员）→ Capability 级定义
- **Bridge 可以扩展权限组** — 安装桥接模块后，权限组获得跨模块能力

```typescript
// 在 purchase_inventory_bridge 中
import { extendPermissionGroup } from '@linchkit/core'

export const ext = extendPermissionGroup('warehouse_manager', {
  permissions: {
    purchase_management: {
      purchase_request: {
        fields: { visible: ['inbound_status'] },
      },
    },
  },
})
```

## 6. 认证技术选型

> 详细认证机制设计见 [10a_authentication.md](10a_authentication.md)

### 6.0 合约/实现分离架构

认证采用**合约/实现分离**模式（Contract/Implementation Split）：

```
@linchkit/core                   ← auth slot + Actor 类型
@linchkit/cap-auth               ← 合约层：Schema 定义 + Action 接口 + AuthProvider 接口 + 中间件壳
@linchkit/cap-auth-better-auth   ← 实现层：better-auth 引擎 + 具体 resolver + OAuth 路由
```

- **cap-auth** 是纯合约包：定义 `AuthProvider` 接口、Schema 形状、Action 签名，但不包含任何具体认证逻辑
- **cap-auth-better-auth** 实现 `AuthProvider`，将 better-auth 的能力注入 cap-auth 合约
- 通过 `createCapAuth({ provider })` 工厂函数组装完整的认证能力

```typescript
import { createCapAuth } from '@linchkit/cap-auth'
import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'

const capAuth = createCapAuth({
  provider: createBetterAuthProvider({ auth: betterAuth({ ... }) }),
})
```

这种分离使得：
- 未来可替换认证引擎（如 Lucia、自研）而不影响 Schema 和 Action 合约
- cap-auth 本身无第三方依赖，保持轻量
- 测试时可注入 mock provider，无需真实认证引擎

### 6.1 核心选型：better-auth

选择 **better-auth** 作为默认认证引擎（通过 `@linchkit/cap-auth-better-auth` 提供），理由：

| 考虑因素 | better-auth 优势 |
|---------|-----------------|
| Elysia 集成 | 官方支持 Elysia plugin + macro 模式，零适配成本 |
| Organization plugin | 内置组织/租户模型，天然匹配 LinchKit 多租户需求 |
| TypeScript-first | 类型安全，与 LinchKit 全栈 TS 一致 |
| 动态角色 | 支持运行时动态分配权限组，无需重启 |
| Session 管理 | 内置 server-side session store，支持 JWT + Refresh Token |

### 6.2 三种认证通道

| 通道 | 适用场景 | 认证方式 | Token 类型 |
|------|---------|---------|-----------|
| Human（浏览器） | Web UI 登录 | OAuth2/OIDC + Session Cookie | 短生命周期 JWT (5-15min) + Refresh Token (httpOnly cookie) |
| M2M（机器间） | 服务间调用、CI/CD、Webhook | API Key | `lk_` 前缀，hashed 存储，scoped，可轮换，绑定 tenant_id |
| AI Agent（MCP/Tool-use） | LLM 工具调用 | Scoped Bearer Token，服务端注入 | 短生命周期 JWT，scope 受限，权限 = scopes ∩ groups_permissions |

### 6.3 Token 策略

- **Access Token**：短生命周期 JWT（默认 15 分钟），内存/sessionStorage 存储
- **Refresh Token**：不透明字符串，httpOnly + Secure + SameSite=Strict cookie
- **API Key**：256-bit 随机 hex，数据库只存 SHA-256 hash，原始 key 仅创建时返回一次
- **AI Agent Token**：由平台注入，Agent 不决定自己的权限

### 6.4 API Key 管理

```typescript
interface ApiKeyRecord {
  id: string
  name: string               // 人类可读标识，如 "CI Pipeline Key"
  key_hash: string           // SHA-256(raw_key)
  key_prefix: string         // 前 8 字符，用于辨识（如 "lk_a1b2"）
  tenant_id: string          // 绑定租户
  actor_id: string           // 关联的 Actor
  scopes: string[]           // 允许的 capability/action
  expires_at?: Date          // 可选过期时间
  last_used_at?: Date
  revoked_at?: Date          // 吊销时间
}
```

生命周期：创建 → 使用中 → 轮换（grace period）→ 吊销。支持 key rotation，旧 key 在 grace period 内仍有效。

## 7. 权限评估机制

### 7.1 合并策略：explicit-deny-wins

采用 AWS IAM 模型的合并策略。用户属于多个权限组时：

1. **收集**所有权限组的权限声明
2. 如果任何一个组 **显式拒绝**（`false`），最终结果为拒绝
3. 如果没有显式拒绝，任何一个组 **允许**（`true`），最终结果为允许
4. 如果没有任何声明，最终结果为拒绝（**默认拒绝**）

```typescript
// 张三 = [staff, purchase_approver]
// staff:             create_request: true,  approve_request: (未声明)
// purchase_approver: create_request: false, approve_request: true

// 合并结果：
// create_request: false  ← explicit deny wins
// approve_request: true  ← 只有一个声明，允许
```

### 7.2 Action 权限检查

```typescript
interface PermissionCheckResult {
  allowed: boolean
  reason?: string              // 拒绝原因（用于"为什么不能"诊断）
  deniedBy?: string            // 哪个权限组拒绝的
}

/**
 * Check if an actor can execute an action.
 * @param actor - The actor attempting the action
 * @param actionName - Action name, e.g. 'approve_request'
 * @param capabilityName - Capability name, e.g. 'purchase_management'
 */
function checkActionPermission(
  actor: Actor,
  actionName: string,
  capabilityName: string,
): PermissionCheckResult
```

### 7.3 数据权限解析

```typescript
type DataAccessCondition = {
  field: string
  operator: 'eq' | 'ne' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte'
  value: unknown
}

/**
 * Resolve the data access condition for an actor on a schema.
 * Returns 'all' (unrestricted), 'none' (no access), or a condition to filter.
 */
function resolveDataAccess(
  actor: Actor,
  schemaName: string,
  operation: 'read' | 'write',
): DataAccessCondition | 'all' | 'none'
```

### 7.4 system_admin 权限组

`system_admin` 是一个 **特殊权限组**（不是 Actor 类型），拥有以下特性：

- 跳过所有 Action 权限检查（`checkActionPermission` 直接返回 `allowed: true`）
- 跳过所有数据权限过滤（`resolveDataAccess` 直接返回 `'all'`）
- 仍然受 Rule Engine 约束（业务规则不跳过）
- 所有操作仍记录 Execution Log（审计不跳过）

```typescript
export const systemAdmin = definePermissionGroup({
  name: 'system_admin',
  label: '系统管理员',
  description: 'Bypasses all permission checks. Does NOT bypass rules or audit.',

  // 不需要逐条声明权限，引擎识别 system_admin 后直接放行
  systemLevel: 'admin',
})
```

> 注意：`system_admin` 是权限组，不是 Actor 类型。任何 Actor 类型（human、ai、external）都可以被分配到 `system_admin` 组，但应严格控制。

### 7.5 前端权限：CASL.js

前端使用 **CASL.js** 构建客户端权限能力对象：

```typescript
import { defineAbility } from '@casl/ability'

// 服务端返回当前用户的权限组解析结果
const serverPermissions = await fetch('/api/my-permissions')

// 构建 CASL ability
const ability = defineAbility((can, cannot) => {
  for (const perm of serverPermissions) {
    if (perm.allowed) {
      can(perm.action, perm.subject, perm.conditions)
    } else {
      cannot(perm.action, perm.subject)
    }
  }
})

// 在 UI 中使用
ability.can('execute', 'approve_request')  // → boolean
```

前端权限仅用于 UI 交互体验（隐藏/禁用按钮），服务端始终做二次校验。

### 7.6 数据库层：Drizzle RLS

使用 Drizzle ORM 的 `pgPolicy` 实现数据库级行级安全（RLS），作为数据权限的最后一道防线：

```typescript
import { pgPolicy } from 'drizzle-orm/pg-core'

// Drizzle schema 中声明 RLS policy
export const purchaseRequestPolicy = pgPolicy('tenant_isolation', {
  for: 'all',
  using: sql`tenant_id = current_setting('app.tenant_id')::text`,
})
```

RLS 确保即使应用层代码有 bug，数据也不会跨租户泄露。

### 7.7 cap-auth 与 cap-permission

认证和权限作为两个独立的 Capability 实现，分别填充 Command Layer 的 slot（见 [16_command_layer_and_api.md](16_command_layer_and_api.md) §2.2）：

| 包 | 角色 | 职责 |
|---|------|------|
| `cap-auth` | 合约层 | 定义 AuthProvider 接口、Schema、Action 签名、中间件壳 |
| `cap-auth-better-auth` | 实现层 | 实现 AuthProvider：better-auth 引擎 + token/session/API key resolver |
| `cap-permission` | 独立能力 | 填充 `permission` slot：读取 Actor.groups → 合并权限（explicit-deny-wins）→ 检查 Action/Data 权限 |

cap-auth 通过 `createCapAuth({ provider })` 工厂函数组装，`provider` 由 cap-auth-better-auth 提供。

未安装 cap-auth 时 → 匿名模式（所有请求使用默认 Actor）。
未安装 cap-permission 时 → 无权限控制（所有 Action 可执行）。

> **注意**：cap-permission 不需要合约/实现分离。权限评估逻辑在 core 中（`checkActionPermission`、`resolveDataAccess`），cap-permission 只是提供管理用的 Schema 和 Action，不存在可替换的"引擎"。

### 7.8 无 Capability 降级行为

cap-auth 和 cap-permission 是**推荐安装**的 Capability，不是框架运行的必要条件。降级行为如下：

| 场景 | Command Layer slot | ctx.actor | 权限检查 | 数据过滤 |
|------|-------------------|-----------|---------|---------|
| 无 cap-auth | auth slot 为空，跳过 | 默认匿名 Actor：`{ type: "system", id: "anonymous", groups: [] }` | — | — |
| 无 cap-permission | permission slot 为空，跳过 | 取决于 cap-auth 是否安装 | 不检查，所有 Action 可执行 | 不过滤，所有数据可访问 |
| 有 cap-auth，无 cap-permission | auth slot 正常，permission slot 跳过 | 正常解析（已认证的真实用户） | 不检查，所有 Action 可执行 | 不过滤 |
| 都不装 | 两个 slot 都为空 | 匿名 Actor | 不检查 | 不过滤 |

**注意：** Rule Engine 是框架核心的一部分（不是 Capability），无论是否安装 cap-auth / cap-permission，所有 Rule 仍然正常执行。业务规则不受认证/权限 Capability 的安装状态影响。

## 8. Permission Storage — DB as Single Source of Truth

### 8.1 Design Principle

**Database is the single source of truth for permissions.** Code provides seed definitions only.

```
Code (definePermissionGroup)        → Seed data, loaded into DB on first boot
    ↓ seed (insert if not exists)
DB: _linchkit.permission_groups     → Project-level, Admin can modify at runtime
  (tenant_id=NULL)
    ↓ override
DB: _linchkit.permission_groups     → Tenant-level overrides
  (tenant_id=X)
```

### 8.2 Database Schema

```sql
CREATE TABLE _linchkit.permission_groups (
  id          VARCHAR(128) PRIMARY KEY,
  tenant_id   VARCHAR(128),            -- NULL = project-level, non-NULL = tenant override
  name        VARCHAR(128) NOT NULL,
  label       VARCHAR(256) NOT NULL,
  description TEXT,
  category    VARCHAR(128),            -- UI grouping (typically capability name)
  implies     TEXT[],                  -- Inherited group names (resolved recursively)
  grant       JSONB NOT NULL DEFAULT '{}',  -- Entity→{actions, data, fields} mapping
  constraints JSONB,                        -- AI constraints, rate limits
  system_level VARCHAR(32),                 -- 'admin' for system_admin
  source      VARCHAR(32) NOT NULL DEFAULT 'manual',  -- 'seed' | 'manual' | 'import'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_perm_groups_tenant ON _linchkit.permission_groups (tenant_id, name);
CREATE INDEX idx_perm_groups_category ON _linchkit.permission_groups (category);
```

### 8.3 Seed Mechanism

On boot, `cap-permission` syncs code definitions to DB:

```typescript
// Insert only if not exists — never overwrite DB changes
await db.insert(permissionGroupsTable)
  .values({ id: name, name, label, tenantId: null, grant, source: 'seed' })
  .onConflictDoNothing();
```

**Key rule:** `onConflictDoNothing` — once a group exists in DB, code seeds never overwrite it.

### 8.4 Admin UI Operations

| Action | Description |
|--------|-------------|
| `create_permission_group` | Create new group (source='manual') |
| `update_permission_group` | Modify group permissions |
| `delete_permission_group` | Remove group (source='manual' only; cannot delete 'seed') |
| `clone_permission_group` | Duplicate as starting point |
| `create_tenant_override` | Tenant-specific override for a project-level group |
| `assign_user_group` | Add user to a permission group |
| `remove_user_group` | Remove user from a permission group |
| `simulate_permissions` | "What can user X do?" diagnostic |

### 8.5 Merge Order

For actor in tenant T:
1. Load project-level groups (tenant_id=NULL)
2. Load tenant-level overrides (tenant_id=T) for same group names
3. Tenant override replaces project-level for the same group name
4. Cross-group merge: explicit-deny-wins (unchanged from §7.1)

## 9. Deprecation: Action-Level permissions.groups

### 9.1 Problem

`defineAction({ permissions: { groups: ["admin"] } })` creates a **second permission check** inside Action Engine that conflicts with PermissionRegistry-based RBAC.

Two checks run on every action:
1. CommandLayer permission slot → full RBAC via PermissionRegistry
2. Action Engine `checkPermissions()` → simple string match

These can conflict. PermissionGroup may allow, but Action's `groups` list blocks (or vice versa).

### 9.2 Resolution

**Deprecate `permissions.groups` on ActionDefinition.** Keep only `permissions.actorTypes`.

All group-based permission logic goes through `definePermissionGroup()` → DB → PermissionRegistry → CommandLayer.

### 9.3 No-Capability Behavior Fix

Current bug: without cap-permission, Action Engine's `checkPermissions()` still runs and denies everything.

Fix: when permission slot is empty, **skip all permission checks** (as documented in §7.8). Requires removing Action Engine's independent check.

Related: GitHub Issue #125

## 10. Milestone Mapping

### M0 ✅
- Actor model implementation
- Basic RBAC (action-level permission check)

### M1 ✅
- better-auth integration + cap-auth Capability
- cap-permission (explicit-deny-wins merge)
- Data access (row-level)
- AI permission constraints

### M2 (current — M5: Platform Maturity)
- **Permission storage in DB** (§8)
- **Seed mechanism** (§8.3)
- **Deprecate action.permissions.groups** (§9) — #125
- **grant + category + implies** (§2.1) — #142
- **Fix no-capability behavior** (§9.3)
- Field-level permission enforcement
- Admin UI for permission management
- Tenant-level permission overrides

### M3 (M6/M7)
- Drizzle RLS (pgPolicy)
- AI rate-limiting enforcement
- "What can I do" diagnostic view
- "Simulate user" admin tool
- Permission audit trail
