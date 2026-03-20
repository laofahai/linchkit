# Capability 结构与组织规范

## 1. Capability 定义

Capability 是 LinchKit 中系统能力的基本组织单位。一个 Capability 代表一个可以独立存在、独立演进的业务模块。

## 2. 粒度原则

判断标准：**它能不能独立存在、独立演进？**

- ✅ 采购管理（包含采购单、采购明细、供应商关联）= 一个 Capability
- ✅ 库存管理（包含仓库、库位、库存记录、出入库单）= 一个 Capability
- ✅ 员工管理（包含员工、部门、职位）= 一个 Capability
- ❌ 采购单 和 采购明细不应拆成两个 Capability — 它们是一体的
- ❌ 仓库 和 库位不应拆成两个 Capability — 库位离开仓库没意义

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
    // 强依赖 — 未安装则拒绝启动
    { capability: '@linchkit/cap-auth', required: true },
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
utility
starter
```

用户可以自定义子分类。Hub 和导航按树形展示。

| 顶级 category | 说明 | 系统权限 | 示例 |
|----------|------|---------|------|
| `system` | 框架核心能力 | 按需 | auth, permission, audit |
| `infrastructure` | 基础设施服务 | 需要声明 | queue, search, storage, cache |
| `integration` | 外部系统集成 | network.external | sms, email, payment, oauth |
| `business` | 业务模块 | 无 | 采购管理, 库存管理, HR |
| `ui` | UI 增强 | 无 | dashboard, report, gantt view |
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
- `business` / `utility` / `ui` 类 Capability 默认无系统权限
- `infrastructure` / `integration` 类显式声明需要的权限
- AI 生成的 Capability 不能声明系统权限（必须人工添加）
- 安装时提示用户确认权限

## 7. Capability 类型（type）

### 7.1 标准 Capability (type: standard)

### 7.2 适配器 Capability (type: adapter)

接管/代理已有系统。详见 17_legacy_system_migration.md。

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
