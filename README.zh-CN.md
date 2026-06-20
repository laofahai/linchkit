# LinchKit

> **AI 原生业务系统的「治理与演化」底座。** 系统的行为被绑定到你声明的意图——实体、动作、规则、制度。任何改动，无论出自人还是 AI，都先经「提议 → 审批」，没有未经审阅的东西能进生产。而系统会从它被实际使用的方式里，提议自己的改进——人来裁决，提议毕业成被强制执行的规则。

[English](./README.md)

---

## LinchKit 是什么？

LinchKit 是这样一层：让一个 AI 原生的业务系统，**始终被绑定到治理它的规则上**。你声明系统的意图——实体、动作、规则、制度——运行时负责强制执行：所有数据变更经由 Action，所有改动（人写的或 AI 提议的）经由 Proposal → 校验 → 审批 流水线，规则在执行时被强制，而不只是写在文档里。

更深的判断：模型只会越来越擅长*生成*系统。LinchKit 是让它们生成的东西、以及人改动的东西，**可被证明地待在声明的规则之内**的那一层；并让系统**安全地演化**：它观察自己被如何实际使用，提议一项改进（一条新规则、一条收紧的制度），人来裁决，提议毕业成被强制执行的代码。AI 永不直接修改生产。

它依然干声明式框架那份活——实体、动作、状态、事件、视图、流程、关系编译成 API、UI、状态管理、事件处理。但那是**怎么做**，不是身份：运行时的存在是为了让行为持续受治理、安全演化，而不只是搭个 CRUD 脚手架。

### 核心主张

1. **统一元模型** — Entity + Action + Rule + State + Event + EventHandler + View + Flow + Relation
2. **AI 深度参与** — 设计、生成、优化，但不能直接改生产
3. **能力为中心** — 一切皆 Capability（业务模块、协议适配器、跨模块桥接），无"插件"概念
4. **唯一写入口** — 所有数据变更经由 Action，GraphQL 仅负责读取
5. **变更治理** — Proposal → 校验 → 审批 → 应用
6. **无限扩展** — 新协议、字段类型、视图类型、服务均通过 Capability extensions 注册

### LinchKit 适合什么

行为必须**持续被声明的制度与规则约束**、且必须**在演化中不跑偏**的系统：内控、审批驱动、合规敏感的业务系统——以及任何需要让*制度*（谁必须审批、什么被允许、什么被禁止）和*执行*（本应遵守它的那一端）保持连接的场景。

不适合：只需要一个无治理、无演化诉求的 CRUD 应用；或计算密集型、实时、底层系统。

---

## 快速开始

```bash
# 安装 CLI
bun add -g @linchkit/cli

# 创建新项目（自动生成 Claude Code、Cursor 等 AI 工具配置）
linch init my-project --ai-tools claude-code,cursor

cd my-project
bun install
linch dev
```

### AI 引导式开发

`linch init` 完成后，用 AI 开发工具打开项目：

- **Claude Code**：输入 `/skill linch:bootstrap`
- **Cursor / Codex / Trae / Copilot**：粘贴 "我刚创建了这个 LinchKit 项目。帮我搭建：了解我想做什么系统，推荐和安装 capabilities，定义实体、动作和规则。"

AI 代理会一步步引导你选择能力、设计实体和动作。

`linch init` 生成的内容：
- `linchkit.config.ts` — 项目配置
- `AGENTS.md` / `CLAUDE.md` — AI 开发指令
- `.mcp.json` — MCP 开发服务器配置
- `.claude/skills/linch/` — 开发技能（实体设计、动作设计等）
- `.cursor/rules/linch/` — Cursor 版本的同样技能

---

## 技术栈

| 层面 | 选型 |
|------|------|
| 语言 | TypeScript（strict 模式）|
| 运行时 | Bun |
| 后端 | Elysia |
| 数据库 | PostgreSQL |
| ORM | Drizzle |
| GraphQL | graphql-yoga + graphql-js（code-first）|
| 工作流引擎 | Restate（持久化执行，双模式）|
| 前端 | React 19 + Vite + TanStack Router |
| UI | Shadcn + Radix + Lucide + Tailwind |
| 代码质量 | Biome + TypeScript strict |

---

## 架构

```
                    ┌─────────────────────────────┐
                    │           入口层             │
                    │  CLI / MCP / HTTP API / UI   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │        Command Layer         │
                    │  pre → auth → exposure →     │
                    │  permission → tenant →       │
                    │  pre-action → post-action    │
                    └──────────┬──────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                     │
   ┌──────▼──────┐    ┌───────▼─────┐    ┌─────────▼────┐
   │   Action    │    │  GraphQL    │    │   Proposal   │
   │   Engine    │    │   (读取)    │    │   Engine     │
   │   (写入)    │    │             │    │   (治理)     │
   └──────┬──────┘    └─────────────┘    └──────────────┘
          │
   ┌──────▼──────┐
   │ Rule Engine │ ← 触发器 + 上下文 + 条件 + 效果
   └──────┬──────┘
          │
   ┌──────▼──────┐    ┌──────────────┐    ┌──────────────┐
   │   状态机    │    │   事件总线   │    │   Restate    │
   │            │    │   + Outbox   │    │   (流程)     │
   └─────────────┘    └──────┬───────┘    └──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  EventHandler    │
                    │  (同步 + 异步)   │
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   PostgreSQL     │
                    │  数据 + 事件     │
                    │  + Outbox + 日志 │
                    └──────────────────┘
```

---

## 元模型

LinchKit 中一切都是声明式定义：

```typescript
import { defineEntity, defineAction, defineRule, defineState, defineRelation } from "@linchkit/core";

// Entity — 带字段和校验的数据结构
const order = defineEntity({
  name: "order",
  label: "订单",
  fields: {
    customer_name: { type: "string", required: true },
    total: { type: "number", min: 0 },
    status: { type: "state" },
  },
});

// Action — 唯一写入口（verb_noun 命名）
const submit_order = defineAction({
  name: "submit_order",
  entity: "order",
  label: "提交订单",
  stateTransition: { from: "draft", to: "pending" },
  policy: { requiresAuth: true },
});

// Rule — 声明式条件 + 效果
const block_large_order = defineRule({
  name: "block_large_order",
  trigger: { type: "action", action: "submit_order" },
  condition: { field: "total", operator: "gt", value: 10000 },
  effect: { type: "require_approval" },
});

// Relation — 一等公民的实体关系
const order_items = defineRelation({
  name: "order_items",
  from: "order",
  to: "order_item",
  cardinality: "one_to_many",
});
```

| 概念 | 用途 | 定义函数 |
|------|------|----------|
| **Entity** | 带字段、校验、系统字段的数据结构 | `defineEntity()` |
| **Action** | 唯一写入口，命名规则 `verb_noun` | `defineAction()` |
| **Rule** | 声明式条件 + 效果 | `defineRule()` |
| **State** | 每个实体实例的有限状态机 | `defineState()` |
| **Event** | 由 Action/状态迁移触发的领域事件 | `defineEvent()` |
| **EventHandler** | 同步/异步事件响应 | `defineEventHandler()` |
| **View** | UI 渲染配置（列表、表单、看板） | `defineView()` |
| **Flow** | 多步骤持久化工作流（Restate 双模式） | `defineFlow()` |
| **Relation** | 一等公民的实体间关系 | `defineRelation()` |

---

## 能力系统

LinchKit 中一切皆 **Capability**：业务模块、协议适配器、跨模块桥接。

```typescript
import { defineCapability } from "@linchkit/core";

export default defineCapability({
  name: "my-feature",
  type: "standard",
  entities: [order],
  actions: [submit_order],
  rules: [block_large_order],
  relations: [order_items],
});
```

**能力类型：**
- `standard` — 业务模块（电商、CRM 等）
- `adapter` — 协议传输（HTTP/GraphQL、MCP、A2A、AG-UI）
- `bridge` — 跨模块桥接

**扩展点：**

| 扩展点 | 用途 | 示例 |
|--------|------|------|
| `fieldTypes` | 自定义字段类型 | 金额、文件、地址 |
| `viewTypes` | 自定义视图类型 | 地图、甘特图、时间线 |
| `ruleEffects` | 自定义规则效果 | 发短信、创建工单 |
| `services` | 可注入的服务 | 存储、搜索 |
| `hooks` | 生命周期钩子 | system.start、action.before |
| `middlewares` | Command Layer 中间件 | 认证、限流 |
| `transports` | 协议适配器 | MCP、A2A、AG-UI |

---

## 包结构

```
packages/ (核心基础设施 — 发布到 npm):
  @linchkit/core                  — 类型、引擎、管道
  @linchkit/cli                   — CLI（linch init、dev、doctor 等）
  @linchkit/devtools              — 测试工具

addons/ (能力分组 — OCA 模型):
  adapter-server/
    @linchkit/cap-adapter-server     — Elysia + graphql-yoga + REST + CommandLayer
  adapter-ui/
    @linchkit/cap-adapter-ui         — React 19 + Shadcn + TanStack（官方 UI）
  adapter-mcp/
    @linchkit/cap-adapter-mcp        — MCP 传输（AI 代理接入）
    @linchkit/cap-mcp-ui             — MCP UI 组件
  adapter-ag-ui/
    @linchkit/cap-adapter-ag-ui      — AG-UI 协议适配器（agent↔前端事件流）
  adapter-a2a/
    @linchkit/cap-adapter-a2a        — A2A（agent 间）协议适配器
  ai-provider/
    @linchkit/cap-ai-provider        — AI SDK providers（Anthropic、OpenAI、zhipu…）
  auth/
    @linchkit/cap-auth               — 认证（JWT、sessions）
    @linchkit/cap-auth-better-auth   — Auth provider（Better Auth）
  permission/
    @linchkit/cap-permission         — 权限引擎（RBAC）
  chatter/
    @linchkit/cap-chatter            — 时间线：消息、审计日志、GraphQL
    @linchkit/cap-chatter-ui         — Chatter React UI 面板
  audit/
    @linchkit/cap-audit-ui           — 审计日志 UI
  flow-restate/
    @linchkit/cap-flow-restate       — Restate 持久化执行
  dry-run/
    @linchkit/cap-dry-run            — 沙箱化执行 dry-run 运行器
  lock/
    @linchkit/cap-lock               — 能力/字段锁策略（Spec 63）
  migration/
    @linchkit/cap-migration          — 数据库迁移工具
  notification/
    @linchkit/cap-notification       — 通知投递
  search/
    @linchkit/cap-search             — 全文检索
    @linchkit/cap-search-ui          — 检索 UI
  file-storage/
    @linchkit/cap-file-storage       — 文件存储
  cache-redis/
    @linchkit/cap-cache-redis        — Redis 缓存 provider
  vector/
    @linchkit/cap-vector-pgvector    — pgvector 向量存储
  observability/
    @linchkit/cap-observability-otel — OpenTelemetry 链路/指标
  theme/
    @linchkit/cap-theme              — 主题
  keyboard-shortcuts/
    @linchkit/cap-keyboard-shortcuts — 键盘快捷键
  view-kanban/
    @linchkit/cap-view-kanban        — 看板视图
  view-calendar/
    @linchkit/cap-view-calendar      — 日历视图
  view-timeline/
    @linchkit/cap-view-timeline      — 时间线视图
  demo/
    @linchkit/cap-life-demo          — 生命系统（Spec 55）演示
    @linchkit/cap-purchase-demo      — 采购管理演示（私有）
```

---

## 能力目录

本仓库中的能力（已发布的可通过 `linch install` 安装；demo 及若干进行中的能力为 `private`、尚未发布到 npm — 见 [VERSIONING.md](VERSIONING.md)）：

类型 + 分类是各能力在 `capability.json` / `package.json#linchkit` 中声明的 OCA 值。

| 能力 | 类型 | 分类 | 说明 |
|------|------|------|------|
| `@linchkit/cap-adapter-server` | adapter | integration | HTTP/GraphQL 服务端（Elysia + graphql-yoga + REST + CommandLayer） |
| `@linchkit/cap-adapter-ui` | adapter | integration | 官方 React UI（Shadcn + TanStack） |
| `@linchkit/cap-adapter-mcp` | adapter | integration | MCP 传输（AI 代理接入） |
| `@linchkit/cap-mcp-ui` | standard | system | MCP UI 组件 |
| `@linchkit/cap-adapter-ag-ui` | adapter | integration | AG-UI 协议适配器（agent↔前端事件流） |
| `@linchkit/cap-adapter-a2a` | adapter | integration | A2A（agent 间）协议适配器 |
| `@linchkit/cap-ai-provider` | adapter | integration | AI SDK providers（Anthropic、OpenAI、zhipu…） |
| `@linchkit/cap-auth` | standard | system | 认证（JWT、sessions） |
| `@linchkit/cap-auth-better-auth` | adapter | system | Auth provider（Better Auth） |
| `@linchkit/cap-permission` | standard | system | 权限引擎（RBAC） |
| `@linchkit/cap-chatter` | standard | system | 时间线：消息、审计日志、GraphQL |
| `@linchkit/cap-chatter-ui` | standard | system | Chatter React UI 面板 |
| `@linchkit/cap-audit-ui` | standard | system | 审计日志 UI |
| `@linchkit/cap-flow-restate` | standard | infrastructure | Restate 持久化执行 |
| `@linchkit/cap-dry-run` | adapter | integration | 沙箱化执行 dry-run 运行器 |
| `@linchkit/cap-lock` | standard | system | 能力/字段锁策略（Spec 63） |
| `@linchkit/cap-migration` | standard | system | 数据库迁移工具 |
| `@linchkit/cap-notification` | standard | system | 通知投递 |
| `@linchkit/cap-file-storage` | standard | system | 文件存储 |
| `@linchkit/cap-cache-redis` | standard | system | Redis 缓存 provider |
| `@linchkit/cap-search` | standard | system | 全文检索 |
| `@linchkit/cap-search-ui` | standard | system | 检索 UI |
| `@linchkit/cap-vector-pgvector` | standard | system | pgvector 向量存储 |
| `@linchkit/cap-observability-otel` | standard | system | OpenTelemetry 链路/指标 |
| `@linchkit/cap-theme` | standard | system | 主题 |
| `@linchkit/cap-keyboard-shortcuts` | standard | system | 键盘快捷键 |
| `@linchkit/cap-view-kanban` | standard | view | 看板视图 |
| `@linchkit/cap-view-calendar` | standard | view | 日历视图 |
| `@linchkit/cap-view-timeline` | standard | view | 时间线视图 |
| `@linchkit/cap-life-demo` | standard | system | 生命系统（Spec 55）演示 |
| `@linchkit/cap-purchase-demo` | standard | business | 采购管理演示（私有） |

第三方能力可通过 PR 提交到能力注册表。

---

## 核心功能

### 运行时实体 Overlay
在运行时为实体添加自定义字段，无需修改代码。Overlay 字段存储在 `_extensions` JSONB 列中，在 UI 表单和列表中渲染，稳定后可"毕业"为永久代码。

### AI 开发工作流
三种 AI 辅助开发模式：
- **本地代理开发** — AI 工具在本地开发，git → PR → 合并
- **运行时 Overlay** — 通过 ProposalEngine → JSONB 增量字段变更（不走 git）
- **AI 自我进化** — 生命系统信号 → PatternDetector → Proposal → 代码生成 → PR

### MCP 开发服务器
`linch mcp-dev` 启动 MCP 服务器，向 AI 工具暴露项目内省能力：
- 发现工具 — 列出/描述实体、动作、关系、能力
- 校验工具 — 在编写代码前验证定义的正确性
- 动态提示 — 基于项目数据的能力开发引导

### 自动生成 UI
Schema 驱动的 UI 组件：
- **AutoForm** — 实体驱动的表单，带校验、状态迁移、overlay 字段
- **AutoList** — TanStack Table，支持排序、筛选、分页、overlay 列
- **管理面板** — 执行日志、指标仪表盘、关系图可视化

### 可观测性
- 告警引擎（条件 + 效果）
- 请求/响应指标收集
- 结构化日志（Pino + 日志 Sink）
- 执行日志仪表盘，完整审计追踪

### 变更治理
- 审批引擎（创建/批准/拒绝/过期）
- Proposal 引擎（校验 + 治理工作流）
- ProposalCodeGenerator（AI 辅助代码生成 + 质量门禁）

---

## CLI 命令

```bash
linch init <name>       # 创建新项目
linch dev               # 启动开发服务器（服务端 + UI）
linch mcp-dev           # 启动 MCP 开发服务器
linch doctor            # 运行健康检查
linch validate          # 校验定义
linch agents-md         # 自动生成 AGENTS.md
linch info              # 项目内省
linch db generate       # 生成迁移 SQL
linch db migrate        # 执行迁移
linch db studio         # 打开 Drizzle Studio
linch overlay promote   # 将 overlay 字段毕业为代码
linch create            # 创建新的能力/实体/动作
linch publish           # 发布包
```

---

## 开发

```bash
# 前置条件：Bun、PostgreSQL、Docker（可选，用于 Restate）

# 启动基础设施
docker compose up -d    # PostgreSQL + Restate

bun install             # 安装依赖
bun run test            # 运行完整测试套件（批量运行器）
bun run dev             # 启动开发服务器（服务端 :3001 + UI :3000）
bun run dev:server      # 仅启动服务端
bun run dev:ui          # 仅启动 UI（代理 API 到 :3001）
bun run check           # Biome lint + format
bun run typecheck       # TypeScript 类型检查

# 数据库管理
bun run db:generate     # 从 schema 变更生成迁移 SQL
bun run db:migrate      # 执行未应用的迁移
bun run db:studio       # 打开 Drizzle Studio GUI
```

## 许可

MIT
