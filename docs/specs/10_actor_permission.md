# Actor 与权限模型设计规范

> 权限管理本身作为系统内置 Capability 实现，见 14_system_capabilities.md

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
  roles: string[]         // 角色列表
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

```typescript
import { definePermissionGroup } from '@linchkit/core'

export const purchaseApprover = definePermissionGroup({
  name: 'purchase_approver',
  label: '采购审批员',
  description: '可以审批和驳回采购申请',

  // 按 Capability 组织，一目了然
  permissions: {
    purchase_management: {
      actions: {
        approve_request: true,
        reject_request: true,
        create_request: false,     // 显式禁止
      },
      data: {
        purchase_request: {
          read: 'all',
        },
      },
    },
  },
})

export const staff = definePermissionGroup({
  name: 'staff',
  label: '普通员工',

  permissions: {
    purchase_management: {
      actions: {
        create_request: true,
        submit_request: true,
        cancel_request: true,
      },
      data: {
        purchase_request: {
          read: { condition: { field: 'requester', operator: 'eq', value: '$actor.id' } },
        },
      },
    },
  },
})

// 用户可以属于多个权限组，权限合并
// 张三 = [staff, purchase_approver]
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

## 3. 数据权限（行级）

除了"能不能调 Action"，还需要控制"能操作哪些数据"。

```typescript
// 数据权限规则
export const staffDataAccess = defineDataAccess({
  role: 'staff',
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

## 4. 与 Capability 的关系

权限定义属于哪里？

- **通用角色**（admin、staff）→ 系统级定义
- **业务角色**（采购经理、仓库管理员）→ Capability 级定义
- **Bridge 可以扩展角色权限** — 安装桥接模块后，角色获得跨模块能力

```typescript
// 在 purchase_inventory_bridge 中
import { extendRole } from '@linchkit/core'

export const ext = extendRole('warehouse_manager', {
  permissions: [
    // 仓库管理员安装桥接模块后，可以查看采购单的入库状态
    { type: 'read', target: 'purchase_request', fields: ['inbound_status'] },
  ],
})
```

## 5. 与里程碑的关系

### M0
- Actor 模型基础实现（记录谁做了什么）
- 基础 RBAC（Action 级别权限检查）
- 不做字段级权限和数据权限

### M1
- 数据权限（行级）
- Proposal / Version 权限
- AI 权限约束

### M2
- 字段级权限
- AI 速率限制
- 完整审计
