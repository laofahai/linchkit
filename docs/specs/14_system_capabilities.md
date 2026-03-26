# 系统内置 Capability 设计规范

## 1. 定位

LinchKit 的系统功能不是框架硬编码的功能，而是官方 Capability 包。

**框架自己吃自己的狗粮** — 系统功能和业务功能用同样的方式定义和运行。

## 2. 三层架构

```
@linchkit/core                        ← 框架内核（不是 Capability）
  ├── Action Engine, Rule Engine, State Engine
  ├── Schema → 多产物生成
  ├── Command Layer
  ├── Event + Outbox
  └── View 渲染引擎

@linchkit/base                        ← 官方基础能力包（一组 Capability）
  ├── 推荐安装（不装也能跑，功能降级）
  │   ├── @linchkit/cap-auth          — 不装 = 匿名模式，所有请求使用默认 Actor
  │   └── @linchkit/cap-permission    — 不装 = 无权限控制，所有 Action 可执行
  │
  ├── 建议安装
  │   ├── @linchkit/cap-audit         — 审计日志
  │   ├── @linchkit/cap-notification  — 通知中心
  │   ├── @linchkit/cap-file-storage  — 文件存储（提供 file 字段类型）
  │   ├── @linchkit/cap-search        — 全文搜索
  │   └── @linchkit/cap-comment       — 评论/动态（类似 Odoo chatter）
  │
  └── 按需安装
      ├── @linchkit/cap-command-palette — Command Palette（Cmd+K 全局搜索/跳转/执行）
      ├── @linchkit/cap-keyboard-shortcuts — 快捷键注册与管理
      ├── @linchkit/cap-theme          — 主题系统（暗色/亮色 + 租户品牌色）
      ├── @linchkit/cap-report        — 报表 + 打印（提供 report View 类型 + PDF/Excel 导出）
      ├── @linchkit/cap-dashboard     — 仪表盘（用户自由拖拽组合 widget）
      ├── @linchkit/cap-import-export — 数据导入导出（CSV/Excel）
      ├── @linchkit/cap-tag           — 标签系统
      ├── @linchkit/cap-scheduler     — 定时任务管理 UI
      ├── @linchkit/cap-proposal      — Proposal 管理 UI
      └── @linchkit/cap-user-profile  — 个人资料

官方启动包（打包一组推荐能力，方便快速上手）
  ├── @linchkit/starter-business    — 企业应用全家桶
  ├── @linchkit/starter-minimal     — 最小化（auth + permission，推荐基线）
  ├── @linchkit/starter-saas        — SaaS 平台（+ 多租户管理 + 计费）
  └── @linchkit/starter-api-only    — 纯 API 服务（无 UI）

行业启动包 / 用户自定义启动包
  └── @my-company/starter-food-industry — 食品行业（+ 食品安全 + 溯源 + 质检）

业务 Capability（用户开发的）
  ├── purchase_management
  ├── inventory_management
  └── ...（弱依赖基础能力，有就增强，没有也能跑）
```

## 3. 初始化方式

```bash
# 推荐：用启动包（开箱即用）
linch init my-project --starter=business

# 最小化
linch init my-project --starter=minimal

# 裸框架（零 Capability，完全自主）
linch init my-project --bare
```

> **`--bare` 模式**：不安装任何 Capability（包括 cap-auth 和 cap-permission）。框架仍可正常运行：匿名模式 + 无权限控制。适合快速原型开发，后续按需添加。

### 启动包定义

启动包本身就是一个 Capability，唯一作用是打包依赖：

```typescript
// @linchkit/starter-business/capability.ts
export default defineCapability({
  name: '@linchkit/starter-business',
  label: '企业应用启动包',
  version: '1.0.0',

  dependencies: [
    { capability: '@linchkit/cap-auth', required: true },
    { capability: '@linchkit/cap-permission', required: true },
    { capability: '@linchkit/cap-audit', required: true },
    { capability: '@linchkit/cap-notification', required: true },
    { capability: '@linchkit/cap-file-storage', required: true },
    { capability: '@linchkit/cap-search', required: true },
    { capability: '@linchkit/cap-comment', required: true },
    { capability: '@linchkit/cap-import-export', required: true },
    { capability: '@linchkit/cap-user-profile', required: true },
    { capability: '@linchkit/cap-dashboard', required: true },
  ],
})
```

### 层次结构

```
@linchkit/core（框架内核）
    ↓
@linchkit/cap-*（官方基础能力）
    ↓
@linchkit/starter-*（官方启动包）
    ↓
行业/自定义启动包（可选）
    ↓
业务 Capability
```

每一层都是 Capability，没有特殊机制。用户也可以做自己的启动包（行业启动包、公司内部启动包等）。

### 降级行为

框架核心不依赖任何 Capability。cap-auth 和 cap-permission 是"推荐安装"而非"必装"：

| 安装情况 | 行为 |
|---------|------|
| 无 cap-auth | 匿名模式：所有请求使用默认 Actor `{ type: "system", id: "anonymous", groups: [] }`，无需登录 |
| 无 cap-permission | 无权限控制：所有 Action 可执行，无数据访问过滤 |
| 有 cap-auth，无 cap-permission | 已认证但无授权检查：知道"你是谁"，但不限制"你能干啥" |
| 都不装 | 框架正常运行，完全开放模式。Rule Engine 仍然生效（Rule 在 core 中，不是 Capability） |

这使得开发/原型阶段的工作流非常顺畅：先装业务 Capability（如采购管理），开始开发，后续再加 auth/permission。

## 4. 基础能力提供什么

### 4.1 @linchkit/cap-auth（认证）— 合约/实现分离

cap-auth 采用**合约/实现分离**架构：

| 包 | 角色 | 依赖 |
|---|------|------|
| `@linchkit/cap-auth` | 合约层 | 仅依赖 `@linchkit/core` |
| `@linchkit/cap-auth-better-auth` | 实现层 | 依赖 cap-auth + better-auth |

```
合约层 (cap-auth):
  Schema: user, session, token, api_key
  Action: login, logout, refresh_token, reset_password, create_api_key (无 handler)
  State: user_lifecycle (active / disabled / locked)
  Interface: AuthProvider (定义认证引擎合约)
  Factory: createCapAuth({ provider }) → 组装完整 Capability

实现层 (cap-auth-better-auth):
  Provider: createBetterAuthProvider({ auth }) → 实现 AuthProvider
  Engine: better-auth (OAuth2/OIDC, Session, Organization)
```

使用方式：
```typescript
import { createCapAuth } from '@linchkit/cap-auth'
import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'

const capAuth = createCapAuth({
  provider: createBetterAuthProvider({ auth: betterAuth({ ... }) }),
})
```

### 4.2 @linchkit/cap-permission（权限）

```
Schema: permission_group, permission
Action: create_group, assign_user, revoke_user, update_permissions
View: permission_matrix, user_permissions（"我能干啥"视图）, simulate_user（"模拟用户"）
```

### 4.3 @linchkit/cap-audit（审计）

```
View: execution_log_list, execution_detail, event_timeline
（不需要独立 Schema — 查询 Execution Log 和 Event 表）
```

### 4.4 @linchkit/cap-notification（通知）

```
Schema: notification, notification_preference
Action: send_notification, mark_read, mark_all_read
View: notification_list, notification_settings
Extension: ruleEffect 'notify'（Rule 可以触发通知）
```

### 4.5 @linchkit/cap-file-storage（文件存储）

```
Schema: file_record
Action: upload_file, delete_file, get_download_url
View: file_list
Extension: fieldType 'file'（所有 Schema 可用）
Extension: service 'storage'（Action handler 可注入）
```

### 4.6 @linchkit/cap-search（全文搜索）

```
Extension: 所有 Schema 自动纳入全文搜索索引
Extension: GraphQL 新增 globalSearch query
Extension: UI 顶部全局搜索框
实现: Postgres 内置全文搜索（M0-M2），可选 Meilisearch（M3+）
```

### 4.7 @linchkit/cap-comment → cap-chatter（评论/动态）

> Detailed design: [Spec 53 — Chatter & Collaboration](./53_chatter_and_collaboration.md). Capability renamed to `@linchkit/cap-chatter` to reflect broader scope.

```
Schema: messages, followers, attachments (system tables in _linchkit schema)
Action: add_comment, add_reply, follow, unfollow
View: 自动在所有 Schema 详情页显示评论区和操作动态
Extension: 自动记录所有 Action 执行为动态条目（EventHandler）
Extension: @mention notifications, follower model, file attachments
类似 Odoo chatter
```

### 4.8 @linchkit/cap-report（报表 + 打印）

```
Extension: viewType 'report'（自定义报表视图）
Extension: 打印模板引擎（HTML → PDF）
Extension: 导出（PDF / Excel）
```

### 4.9 @linchkit/cap-dashboard（仪表盘）

```
View: dashboard_builder（用户自由拖拽组合 widget）
Extension: 每个 Capability 的 View 可以注册为 dashboard widget
```

### 4.10 @linchkit/cap-import-export（数据导入导出）

```
Action: import_data, export_data
View: import_wizard, export_wizard
支持 CSV / Excel
```

## 5. 业务 Capability 如何使用基础能力

### 自动增强（无需代码）

```typescript
defineSchema({
  name: 'purchase_request',
  fields: {
    attachment: { type: 'file' },    // cap-file-storage 提供
  },
  features: {
    comments: true,     // cap-comment 提供评论区
    activityLog: true,  // cap-comment 提供操作动态
    search: true,       // cap-search 纳入全文搜索
    tags: true,         // cap-tag 支持标签
  },
})
```

以上 features 都是弱依赖 — 对应基础能力未安装时自动降级（不显示、不报错）。

### 在 Action handler 中使用

```typescript
handler: async (ctx) => {
  // 通过 service 注入
  if (ctx.hasCapability('cap-file-storage')) {
    const storage = ctx.service('storage')
    await storage.upload(...)
  }

  // 通过 execute 调用
  if (ctx.hasCapability('cap-notification')) {
    await ctx.execute('cap-notification.send', { ... })
  }
}
```

## 6. 与里程碑的关系

### M0
- cap-auth（基础登录）
- cap-permission（基础权限）

### M1
- cap-audit
- cap-proposal
- cap-file-storage
- cap-search（Postgres 内置）

### M2
- cap-notification
- cap-comment
- cap-user-profile
- cap-import-export

### M3
- cap-report
- cap-dashboard
- cap-tag
- cap-scheduler
