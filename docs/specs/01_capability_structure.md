# Capability 结构与组织规范

> Tracking milestones:
> - foundational capability architecture reference
>
> Related issues:
> - GitHub Issue `#84` — Repository separation: core vs official capabilities
> - GitHub Issue `#85` — Capability Hub: discovery and marketplace
>
> Execution source of truth: GitHub milestones and issues.

## 1. Capability 定义

Capability 是 LinchKit 中系统能力的基本组织单位。一个 Capability 代表一个可以独立存在、独立演进的业务模块。

## 2. 粒度原则

判断标准：**它能不能独立存在、独立演进？**

- ✅ 采购管理（包含采购单、采购明细、供应商关联）= 一个 Capability
- ✅ 库存管理（包含仓库、库位、库存记录、出入库单）= 一个 Capability
- ✅ 员工管理（包含员工、部门、职位）= 一个 Capability
- ❌ 采购单 和 采购明细不应拆成两个 Capability — 它们是一体的
- ❌ 仓库 和 库位不应拆成两个 Capability — 库位离开仓库没意义

## 2.5 项目目录结构

核心基础设施和可插拔能力分为两个顶层目录：

```
packages/                          ← 核心基础设施（不可替换，极简）
  core/                            — 引擎 + 类型 + 管道（最小内核）
  cli/                             — 极简引导器（init + dev + 动态加载 capability commands）
  devtools/                        — 测试工具（devDependency，不参与运行时）

capabilities/                      ← 可插拔能力（全部可选安装）
  cap-adapter-server/              — HTTP/GraphQL transport
  cap-adapter-mcp/                 — MCP transport
  cap-adapter-ui/            — 官方 UI Shell（React + Shadcn + TanStack）
  cap-auth/                        — 认证契约
  cap-auth-better-auth/            — 认证实现（Better Auth）
  cap-permission/                  — 权限
  cap-admin/                       — 管理后台（execution log、schema 浏览器）
  purchase_management/             — 业务模块示例
  cap-bridge-purchase-inventory/   — 桥接模块示例
```

**分离原则**：
- `packages/` 只有 3 个包：core（内核）、cli（引导器）、devtools（开发工具）
- `capabilities/` 中的包全部可选，按需组合
- CLI 是极简引导器：读 `linchkit.config.ts` → 加载 Core → 扫描 capabilities → 注册 extensions → 启动 transports
- CLI 自身只提供 `linch init` 和 `linch start`，其他命令由 Capability 注册

**命名规范**：

| 前缀 | type | 说明 | 示例 |
|------|------|------|------|
| `cap-adapter-*` | adapter | 协议/传输适配器 | cap-adapter-server, cap-adapter-mcp, cap-adapter-ui |
| `cap-bridge-*` | bridge | 跨模块桥接 | cap-bridge-purchase-inventory |
| `cap-*` | standard | 标准能力模块 | cap-auth, cap-permission, cap-admin |
| 无前缀 | standard | 业务模块 | purchase_management, inventory_management |

npm 发包名：`@linchkit/cap-adapter-mcp`、`@linchkit/cap-auth`、`@linchkit/cap-bridge-xxx`。

**不同场景的组合**：

| 场景 | 加载的 Capabilities |
|------|-------------------|
| 完整 Web 应用 | cap-adapter-server + cap-adapter-ui + cap-auth + cap-permission + 业务 cap |
| AI-only（纯 MCP） | cap-adapter-mcp + cap-auth + 业务 cap |
| CLI 工具 | 业务 cap（cli 直接调 CommandLayer） |
| Headless API | cap-adapter-server + cap-auth + 业务 cap |

## 3. 文件组织

每个 Capability 一个目录，内部按类型拆分文件：

```
capabilities/
  purchase_management/
    capability.ts            # 模块元信息、版本、依赖声明
    schema/
      purchase_request.ts
      purchase_item.ts
    actions/
      create_request.ts
      submit_request.ts
      approve_request.ts
    rules/
      amount_check.ts
      role_check.ts
    states/
      request_lifecycle.ts
```

拆分原因：
- AI 修改一个 Rule 只需读写一个文件
- Proposal 的 diff 清晰（如"新增 rules/budget_check.ts"）
- 版本管理方便，每个文件可单独追踪变更

## 4. Capability 元信息

```typescript
import { defineCapability } from '@linchkit/core'

export default defineCapability({
  name: 'purchase_management',
  version: '1.0.0',
  description: '采购管理模块',

  dependencies: [
    {
      capability: 'employee_management',
      use: {
        schemas: ['employee', 'department'],
      }
    },
    {
      capability: 'inventory_management',
      use: {
        schemas: ['warehouse'],
        actions: ['create_inbound'],
      }
    }
  ],
})
```

依赖必须显式声明，包括用了哪些 schema 和 action。

### 强依赖 vs 弱依赖

```typescript
export default defineCapability({
  name: 'purchase_management',
  category: 'business',                    // 分类
  tags: ['procurement', 'finance'],        // 标签

  dependencies: [
    // 弱依赖 — cap-auth 未安装时进入匿名模式，业务功能仍可运行
    { capability: '@linchkit/cap-auth', required: false },
    // 强依赖 — 未安装则拒绝启动
    { capability: 'employee_management', required: true,
      use: { schemas: ['employee', 'department'] } },

    // 弱依赖 — 未安装则自动降级
    { capability: '@linchkit/cap-comment', required: false },
    { capability: '@linchkit/cap-file-storage', required: false },
    { capability: '@linchkit/cap-search', required: false },
  ],

  // 系统权限（业务模块通常不需要）
  systemPermissions: [],
})
```

| 场景 | 强依赖未安装 | 弱依赖未安装 |
|------|:---:|:---:|
| 启动 | 报错，拒绝启动 | 正常启动，记录 warning |
| 用到相关功能 | — | 自动降级（跳过/隐藏） |
| Validation | 报错 | 提示可选安装建议 |

弱依赖的自动降级：
- `{ type: 'file' }` 字段：cap-file-storage 未装时不渲染、不建表
- `features.comments: true`：cap-comment 未装时不显示评论区
- Action handler 中通过 `ctx.hasCapability('cap-xxx')` 检测

## 5. Capability 类型

### 5.1 标准 Capability (type: standard)

独立的业务模块，有自己的 Schema、Action、Rule、State。

## 5. Capability 分类（category）

Category 支持层级（parent），用点号分隔：

```
system
infrastructure
integration
business
  business.procurement     — 采购
  business.inventory       — 库存
  business.hr              — 人力资源
  business.finance         — 财务
  business.sales           — 销售
  business.project         — 项目管理
ui
view
utility
starter
```

用户可以自定义子分类。Hub 和导航按树形展示。

| 顶级 category | 说明 | 系统权限 | 示例 |
|----------|------|---------|------|
| `system` | 框架核心能力 | 按需 | auth, permission, audit |
| `infrastructure` | 基础设施服务 | 需要声明 | queue, search, storage, cache |
| `integration` | 外部系统集成 | network.external | **cap-adapter-server (HTTP/GraphQL)**, cap-adapter-mcp, cap-adapter-a2a, cap-adapter-ag-ui, sms, email, payment |
| `business` | 业务模块 | 无 | 采购管理, 库存管理, HR |
| `ui` | UI 增强 | 无 | **cap-adapter-ui (shell)**, cap-admin, dashboard, report, gantt view |
| `view` | UI 视图渲染能力 | 无 | cap-view-calendar, cap-view-kanban, cap-view-timeline |
| `utility` | 通用工具 | 无 | import-export, tag, comment |
| `starter` | 启动包 | 无 | starter-business, starter-saas |

## 6. 系统权限（systemPermissions）

Capability 可以声明需要的系统级权限，安装时用户确认：

| 权限 | 说明 | 谁需要 |
|------|------|--------|
| `database.create_table` | 创建表 | 有 Schema 的 Capability（框架自动授予） |
| `database.create_index` | 创建索引 | search |
| `database.raw_query` | 原始 SQL | 特殊场景 |
| `network.internal` | 访问内网服务 | search, queue |
| `network.external` | 访问外部 API | sms, email, payment |
| `filesystem.read` | 读文件系统 | file-storage |
| `filesystem.write` | 写文件系统 | file-storage, report |
| `process.spawn` | 启动子进程 | 极少数 |

安全原则：
- `business` / `utility` / `ui` / `view` 类 Capability 默认无系统权限
- `infrastructure` / `integration` 类显式声明需要的权限
- AI 生成的 Capability 不能声明系统权限（必须人工添加）
- 安装时提示用户确认权限

## 7. Capability 类型（type）

### 7.1 标准 Capability (type: standard)

### 7.2 适配器 Capability (type: adapter)

适配器有两类用途：

**A. 协议适配器** — 为 CommandLayer 注册新的传输入口，让外部系统通过新协议访问 LinchKit。

| Capability | 协议 | 用途 |
|---|---|---|
| `cap-adapter-mcp` | Model Context Protocol | AI Agent 调用 Actions/查询 Schemas |
| `cap-adapter-server` | HTTP / GraphQL | REST API + GraphQL 查询/变更 |
| `cap-adapter-a2a` | Agent-to-Agent Protocol | Agent 间协作通信 |
| `cap-adapter-ag-ui` | AG-UI Protocol | AI Agent 与前端 UI 实时交互 |

协议适配器通过 `extensions.transports` 注册（详见 20_extension_mechanism.md §8.5）。Core 不需要为新协议做任何改动。

```typescript
export default defineCapability({
  name: 'cap-adapter-mcp',
  type: 'adapter',
  category: 'integration',
  version: '0.1.0',

  extensions: {
    transports: [
      { name: 'mcp', factory: createMcpTransport },
    ],
  },

  systemPermissions: ['network.internal'],
})
```

**B. 遗留系统适配器** — 接管/代理已有系统，将旧系统封装为 LinchKit Capability。详见 17_legacy_system_migration.md。

### 5.3 桥接 Capability (type: bridge)

连接两个或多个独立 Capability，提供跨模块关联能力。

核心原则：
- **不修改原模块的定义**，通过扩展（extension）和事件监听来关联
- **卸掉桥接模块，两个原模块不受影响**
- 桥接模块也走版本管理和治理流程

桥接模块可以：
- **扩展（extend）** — 给已有 Schema 加字段、加新 Rule、加新 Action
- **覆盖（override）** — 修改已有 Schema 字段属性、替换 Rule 条件、修改 Action 行为
- 监听其他模块的事件并触发动作
- 定义跨模块的 Rule
- 定义跨模块的 Flow

```typescript
import { defineCapability } from '@linchkit/core'

export default defineCapability({
  name: 'purchase_inventory_bridge',
  version: '1.0.0',
  type: 'bridge',
  priority: 10,  // 加载优先级，数字越大越后执行，覆盖先执行的

  bridges: [
    { capability: 'purchase_management' },
    { capability: 'inventory_management' },
  ],
})
```

### 扩展 vs 覆盖

**扩展（extend）** — 加新东西，安全，默认允许：
```typescript
import { extendSchema } from '@linchkit/core'

export const ext = extendSchema('purchase_request', {
  fields: {
    inbound_status: { type: 'ref', target: 'inbound_order.status', label: '入库状态' },
  }
})
```

**覆盖（override）** — 改已有的东西，必须显式声明：
```typescript
import { overrideSchema, overrideRule, overrideAction } from '@linchkit/core'

// 覆盖 Schema 字段属性
export const ovr = overrideSchema('purchase_request', {
  fields: {
    amount: { max: 5000000 },        // 金额上限从100万改成500万
    description: { required: true },  // 描述从选填改成必填
  }
})

// 覆盖 Rule 条件
export const ovr = overrideRule('amount_check', {
  condition: ({ input }) => input.amount > 50000,  // 阈值从1万改成5万
})

// 覆盖 Action — 在原 handler 前后插入逻辑
export const ovr = overrideAction('submit_request', {
  before: async (ctx) => { /* 原 handler 之前执行 */ },
  after: async (ctx) => { /* 原 handler 之后执行 */ },
})

// 或完全替换 Action handler
export const ovr = overrideAction('submit_request', {
  handler: async (ctx) => { /* 完全替换 */ },
})
```

### 多模块覆盖的执行顺序（洋葱模型）

当多个 Bridge 覆盖同一个目标时，采用洋葱模型：

```
priority 高的在外层，低的在内层，最核心是原方法

B.before (priority 20) → A.before (priority 10) → 原方法 → A.after → B.after
```

#### before/after 覆盖

多个模块的 before/after 按 priority 形成链式调用：

```typescript
// Bridge A: priority 10
overrideAction('submit_request', {
  before: async (ctx) => { /* A 的前置逻辑 */ },
  after: async (ctx) => { /* A 的后置逻辑 */ },
})

// Bridge B: priority 20（外层）
overrideAction('submit_request', {
  before: async (ctx) => { /* B 的前置逻辑 */ },
  after: async (ctx) => { /* B 的后置逻辑 */ },
})

// 执行顺序：B.before → A.before → 原方法 → A.after → B.after
```

#### replace 覆盖（完全替换）

- 只有最外层（priority 最高）的 replace 生效
- 如果多个模块都 replace 同一目标，Validation 报冲突，必须人工解决
- replace 的模块可以通过 `ctx.callOriginal()` 调用原方法（类似 super）

```typescript
overrideAction('submit_request', {
  handler: async (ctx) => {
    // 自定义逻辑
    doSomething()
    // 可以调用原方法
    const result = await ctx.callOriginal()
    doSomethingAfter()
    return result
  },
})
```

#### Schema/Rule/View 覆盖

- **Schema 字段覆盖**：多个模块改同一字段的不同属性 → 合并（如 A 改 max，B 改 required）
- **Schema 字段覆盖冲突**：多个模块改同一字段的同一属性 → priority 高的生效，Validation 警告
- **Rule 覆盖**：同上，priority 高的生效
- **View 覆盖**：多个模块 extendView → 按 priority 顺序追加字段

#### 冲突检测

Validation 阶段自动检测：
- 多个模块 replace 同一 Action → 报错
- 多个模块修改同一 Schema 字段的同一属性 → 警告
- 多个模块修改同一 Rule 的 condition → 警告
```

## 6. 依赖规则

### 6.1 依赖必须是 DAG（有向无环）

不允许循环依赖。框架启动时检测依赖图，发现循环直接报错。

```
✅ 允许：
  采购管理 → 员工管理
  库存管理 → 员工管理
  采购库存桥接 → 采购管理, 库存管理

❌ 不允许：
  采购管理 → 库存管理 → 采购管理（循环）
```

如果两个 Capability 互相需要，应该通过 Bridge 解耦，而不是直接互相依赖。

### 6.2 依赖的加载顺序

按拓扑排序加载：被依赖的先加载，依赖方后加载。Bridge 最后加载（因为它依赖两端）。

### 6.3 依赖的作用

1. **AI 可见** — 知道改某模块可能影响哪些模块
2. **Validation 可检查** — 删除被依赖的 schema 时能提前报错
3. **版本兼容** — 升级某模块时能检查依赖方是否兼容
4. **卸载保护** — 被其他 Capability 依赖的模块不能卸载
5. **循环检测** — 新增依赖时自动检查是否形成环

---

> **相关规范**：[56 — 核心瘦身](./56_core_slimming.md)（核心与 Capability 边界重新划定，~17 文件安全移出核心）。
