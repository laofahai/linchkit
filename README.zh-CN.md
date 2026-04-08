# LinchKit

> **AI Native 的软件能力运行时。** 任何以数据、规则、状态为核心的软件系统，都可以在这个框架上通过 AI 与人协作逐步"生长"出来，并在统一的治理体系下安全运行和持续演进。

[English](./README.md)

---

## LinchKit 是什么？

LinchKit 是一个框架：你用声明式方式**定义**软件系统（实体、动作、规则、状态、事件、视图、流程、关系），运行时自动完成其余工作——API 生成、UI 渲染、状态管理、事件处理和变更治理。

AI 代理（Claude Code、Cursor、Codex、Copilot、Trae）与人类协作设计和生成完整的能力模块。框架提供护栏：所有写入经由 Action，所有变更经由 Proposal，质量门禁在代码发布前强制执行标准。

### 核心主张

1. **统一元模型** — Entity + Action + Rule + State + Event + EventHandler + View + Flow + Relation
2. **AI 深度参与** — 设计、生成、优化，但不能直接改生产
3. **能力为中心** — 一切皆 Capability（业务模块、协议适配器、跨模块桥接），无"插件"概念
4. **唯一写入口** — 所有数据变更经由 Action，GraphQL 仅负责读取
5. **变更治理** — Proposal → 校验 → 审批 → 应用
6. **无限扩展** — 新协议、字段类型、视图类型、服务均通过 Capability extensions 注册

### 适用范围

电商、SaaS、项目管理、CMS、ERP、预约系统、IoT 管理平台 — 只要核心是数据 + 规则 + 状态的软件。

不适用于：计算密集型、实时系统、底层系统。

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
    @linchkit/cap-adapter-server  — Elysia + graphql-yoga + REST + CommandLayer
  adapter-ui/
    @linchkit/cap-adapter-ui      — React 19 + Shadcn + TanStack（官方 UI）
  adapter-mcp/
    @linchkit/cap-adapter-mcp     — MCP 传输（AI 代理接入）
    @linchkit/cap-mcp-ui          — MCP UI 组件
  chatter/
    @linchkit/cap-chatter         — 时间线：消息、审计日志、GraphQL
    @linchkit/cap-chatter-ui      — Chatter React UI 面板
  auth/
    @linchkit/cap-auth            — 认证（JWT、sessions）
    @linchkit/cap-auth-better-auth — Auth provider（Better Auth）
  permission/
    @linchkit/cap-permission      — 权限引擎（RBAC）
  ai-provider/
    @linchkit/cap-ai-provider     — AI SDK（Anthropic、OpenAI、自定义）
  flow-restate/
    @linchkit/cap-flow-restate    — Restate 持久化执行
  migration/
    @linchkit/cap-migration       — 数据库迁移工具
  demo/
    @linchkit/cap-purchase-demo   — 演示：采购管理场景
```

---

## 能力目录

通过 `linch install` 安装官方能力：

| 能力 | 类型 | 分类 | 说明 |
|------|------|------|------|
| `@linchkit/cap-adapter-server` | adapter | transport | HTTP/GraphQL 服务端（Elysia + graphql-yoga） |
| `@linchkit/cap-adapter-ui` | adapter | transport | 官方 React UI（Shadcn + TanStack） |
| `@linchkit/cap-adapter-mcp` | adapter | transport | MCP 传输（AI 代理接入） |
| `@linchkit/cap-auth` | standard | auth | 认证（JWT、sessions） |
| `@linchkit/cap-auth-better-auth` | standard | auth | Auth provider（Better Auth） |
| `@linchkit/cap-permission` | standard | auth | 权限引擎（RBAC） |
| `@linchkit/cap-chatter` | standard | collaboration | 时间线：消息、审计日志 |
| `@linchkit/cap-ai-provider` | standard | ai | AI SDK（Anthropic、OpenAI） |
| `@linchkit/cap-flow-restate` | standard | workflow | Restate 持久化执行 |
| `@linchkit/cap-migration` | standard | infrastructure | 数据库迁移工具 |

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
bun test                # 运行测试
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
