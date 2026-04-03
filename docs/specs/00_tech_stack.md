# LinchKit 技术栈与基础设施

## 1. 核心技术选型

| 层面 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript | 全栈统一语言，类型系统强 |
| 运行时 | **Bun（不兼容 Node）** | 原生 TS、性能好、内置工具链 |
| 数据库 | PostgreSQL | 事务强，JSONB 灵活，Outbox 友好 |
| ORM | Drizzle ORM | Type-safe，轻量，接近 SQL |
| 后端框架 | **Elysia**（HTTP 层做薄抽象，保留切换能力） | Bun 原生，type-safe，性能最好 |
| GraphQL | **graphql-yoga + graphql-js**（code-first，NOT Pothos） | 读操作统一用 GraphQL，The Guild 维护，Bun 原生兼容 |
| 测试 | **Bun 内置测试运行器** | 不需要 Vitest |
| 包管理 | **Bun workspace** (monorepo) | Bun 原生 workspace |
| 前端框架 | **React + Vite + TanStack Router** | SPA，type-safe routing |
| UI 组件 | Shadcn UI + Lucide + Tailwind | headless，可定制 |

### 为什么绑定 Bun

- 原生运行 TypeScript，不需要编译步骤
- 内置测试运行器、包管理器、bundler
- `Bun.serve` 性能远超 Node HTTP
- 内置 SQLite（测试时可不依赖 Postgres）
- API 更简洁（`Bun.file`、`Bun.write` 等）
- 启动速度快（蓝绿部署切换更快）

### 已知风险与缓解措施

- **Bun 兼容性**：4900+ open issues，Drizzle JSON 类型字段和 pino transport 有已知兼容性问题。缓解：项目启动第一周做关键依赖兼容性验证。
- **Elysia 成熟度**：社区规模较小（~17.6k stars），无大规模生产案例。缓解：HTTP 层做薄抽象（adapter interface），保留切换到 Hono 的能力。
- **pino + Bun**：pino-pretty 的 worker thread 在 Bun 下需要 bun-plugin-pino 插件。

## 2. 定义格式

**使用 TypeScript，不用 YAML/JSON。**

通过 `defineXxx()` 函数做声明式定义：

```typescript
import { defineSchema, defineAction, defineRule, defineView } from '@linchkit/core'
```

理由：
- 类型检查，写错直接报红
- 自动补全
- 可复用、组合、引用
- AI 生成 TS 比 YAML 准确
- 与 Action 代码实现在同一语言体系

## 3. 统一 Command Layer

所有入口（CLI、MCP、HTTP API、UI）走同一个 Command Layer，核心逻辑写一次。

```
CLI ──────┐
MCP ──────┤
HTTP API ─┤──→ Command Layer ──→ Action Engine (写)
UI ───────┘         │
                    └──→ GraphQL / Query Engine (读)
```

详见 16_command_layer_and_api.md。

## 4. 三方集成

### 4.1 核心依赖（M0 即用）

| 领域 | 方案 | 用途 |
|------|------|------|
| 后端框架 | Elysia | HTTP + WebSocket + 插件体系 |
| 状态机 | **自研实现**（纯 TS，200-400 行，XState 作为可选升级路径） | State Machine 定义、迁移、guard、元信息 |
| Schema → 产物 | Zod（校验）、Drizzle（DB）、GraphQL types（查询） | 一个 Schema 定义自动生成多种产物 |
| 事件总线(进程内) | **自研 EventBus** | 进程内事件分发（优先级排序、payload filter、sync/async 双模式、与持久化层集成） |
| 数据库迁移 | Drizzle Kit | Schema 变更自动生成迁移 |
| GraphQL | **graphql-yoga + graphql-js** | 读操作，code-first schema builder（NOT Pothos），通过 graphql-yoga 集成到 Elysia |
| CLI | citty (UnJS) | 命令行工具 |
| MCP | @modelcontextprotocol/sdk | AI 能力暴露，复用 Command Layer |
| 日志 | pino（通过 Logger 接口适配） | 结构化日志，trace context 自动注入 |
| ID 生成 | crypto.randomUUID() | 原生 API，零依赖 |
| 配置管理 | **自研 ConfigRegistry + Zod** | Capability 级 schema 声明、环境变量解析、Zod 校验（详见 spec 42） |
| 定时任务 | croner | 轻量 cron 调度 |
| 前端 | React + Vite + TanStack Router | SPA 管理界面 |
| UI | Shadcn UI + Lucide + Tailwind | 组件 + 图标 + 样式 |
| i18n | i18next（或类似方案） | 多语言 |
| 认证 | **better-auth** | OAuth2/OIDC、Session、Organization plugin、API Key 管理。Elysia 原生集成。详见 [10a_authentication.md](10a_authentication.md) |

### 4.2 M1 集成

| 领域 | 方案 | 用途 |
|------|------|------|
| 工作流编排 | **Restate** (`@restatedev/restate-sdk` v1.11.1) | 所有多步骤流程（业务/AI/部署/迁移），FlowDefinition 编译为 Restate virtual object。单 Rust 二进制，无外部依赖，Bun 官方支持。双模式：有 Restate server = 持久化执行；无 = 同步回退 |

### 4.3 稍后集成

| 领域 | 方案 | 时机 |
|------|------|------|
| 任务队列 | BullMQ (Redis) | Outbox 轮询不够用时 |

### 4.3 必须自研

| 领域 | 理由 |
|------|------|
| Command Layer | 统一入口层，CLI/MCP/API 的核心 |
| Rule Engine | 现成方案与 Context 模型不匹配 |
| Capability 模型 | 核心差异化 |
| Proposal / Validation | 核心差异化 |
| Action 执行引擎 | 与 Rule/State/Event 深度耦合 |
| Event 持久化 / Outbox | 与业务耦合深，Postgres 表实现 |
| 版本管理 / 发布 / 回滚 | 核心治理能力 |
| View 渲染引擎（headless）| Schema → 自动 UI 的核心 |
| Schema → 多产物生成 | Zod/Drizzle/GraphQL/TS type 自动生成 |
| 多租户 | 架构级关注 |
| 事件总线 | 需要优先级、filter、async 模式、与持久化/Outbox 深度集成 |
| 配置中心 | c12 不支持 Capability 级 schema 声明和作用域级联（详见 spec 42） |

## 5. Monorepo 包结构

```
packages/ (core infrastructure):
  @linchkit/core                  — 核心运行时（Action/Rule/State/Event/Schema/Flow 引擎 + 类型 + 管道）
  @linchkit/cli                   — CLI 工具（基于 citty，linch init/dev/db 命令）
  @linchkit/devtools              — 测试工具 + 开发调试

capabilities/ (pluggable):
  @linchkit/cap-adapter-server    — HTTP/GraphQL transport（Elysia + graphql-yoga + REST + CommandLayer）
  @linchkit/cap-adapter-mcp       — MCP transport（AI 代理接入）
  @linchkit/cap-adapter-ui  — 官方 UI shell（React + Shadcn + TanStack）
  @linchkit/cap-auth              — 认证（JWT, sessions）
  @linchkit/cap-auth-better-auth  — Auth provider（Better Auth 集成）
  @linchkit/cap-permission        — 权限引擎（RBAC）
  @linchkit/cap-purchase-demo     — 演示：采购管理场景（private）
```

拆包原则：
- 按部署边界拆（服务端 / 客户端必须分开）
- 按可选性拆（MCP 是可选安装）
- 紧耦合的合并（ui + ui-hooks → ui，ai-context 拆散到 core/cli/mcp，test → devtools）

## 6. 基础设施清单

### 6.1 M0 必须

1. **配置中心** — 系统级 + Capability 级配置，环境区分
2. **事件总线** — 进程内 + Postgres Outbox
3. **数据访问层** — Schema → Drizzle → Postgres，GraphQL 自动生成
4. **身份与权限** — Actor 模型，权限组
5. **执行引擎** — Action 调度、Rule 引擎、State Machine、Transaction、Execution Log
6. **Command Layer** — 统一入口，CLI + HTTP API
7. **基础 UI** — 自动生成 list + form + 导航
8. **多租户基础** — Schema 系统字段预留 tenant_id
9. **i18n 基础** — label / message 支持多语言 key

### 6.2 稍后补充

10. **MCP 适配器** — AI 接入
11. **定时任务调度** — cron 触发
12. **文件/附件管理** — 系统 Capability
13. **通知服务** — 系统 Capability
14. **GitHub 集成** — PR 审批 + Webhook 部署
15. **多租户完整** — 租户管理、数据隔离、租户级配置
16. **i18n 完整** — 翻译管理、语言切换

### 6.3 暂时不需要

- 分布式调度
- 消息队列（MQ）
- Graph 数据库
- RAG / 向量检索
- 监控告警平台

## 7. Schema 多产物生成

```
defineSchema()
    ├── Zod schema       → 运行时输入校验
    ├── Drizzle schema   → 数据库建表和查询
    ├── TypeScript type   → 开发时类型推导
    ├── GraphQL type      → 读操作查询
    └── JSON Schema       → MCP / 外部 API 描述
```

## 8. 查询语法统一

MongoDB 风格查询语法，三处复用：
- GraphQL filter 参数
- Rule Context 数据查询
- View 的 filter 定义

## 9. 多租户架构预留

### 方案：行级隔离（Row-Level）

每张业务表自动包含 `tenant_id` 系统字段：

```typescript
// Schema 自动字段（加上之前的 id, created_at 等）
tenant_id   — 租户 ID
```

所有查询自动附加 `WHERE tenant_id = current_tenant`。

### 未来可选方案

| 方案 | 隔离级别 | 适用场景 |
|------|----------|---------|
| 行级隔离 | 低 | SaaS 默认方案 |
| Schema 级隔离 | 中 | 租户需要部分定制 |
| 数据库级隔离 | 高 | 大租户、合规要求 |

M0 用行级隔离，后续按需升级。

## 10. i18n 方案

### label / message 多语言

所有面向用户的文本支持 i18n key：

```typescript
defineSchema({
  name: 'purchase_request',
  label: 't:purchase_request._label',  // 引用翻译 key
  fields: {
    title: { type: 'string', label: 't:purchase_request.title' },
    amount: { type: 'number', label: 't:purchase_request.amount' },
  }
})
```

翻译文件：

```typescript
// locales/zh.ts
export default {
  purchase_request: {
    _label: '采购申请',
    title: '标题',
    amount: '金额',
  }
}
```

如果 label 不以 `t:` 开头，就是纯文本（不需要翻译的场景）。
