# 统一 Command Layer、API、CLI、MCP 设计规范

## 1. 核心架构

```
CLI ──────┐
MCP ──────┤
HTTP API ─┤──→ Command Layer ──→ Action Engine (写)
UI ───────┘         │
                    └──→ Query Engine / GraphQL (读)
```

所有入口（CLI、MCP、HTTP API、UI）走同一个 Command Layer。核心逻辑写一次，不同传输协议只是适配器。

> 所有入口（HTTP、MCP、UI）均由 Capability（type: adapter）通过 `extensions.transports` 注册。Core 只提供 CommandLayer 管道，不内置任何 transport。CLI 是唯一的内置入口，作为编排器加载 Capability 并启动 transport。
>
> - `cap-adapter-server` — 注册 HTTP REST + GraphQL transport
> - `cap-adapter-mcp` — 注册 MCP transport（stdio + Streamable HTTP）
> - `cap-adapter-ui` — 注册 UI Shell（通过 cap-adapter-server 的 HTTP 服务静态文件）
>
> 不同部署场景只需加载不同的 adapter Capability，Core 代码不变。

## 2. Command Layer

### 2.1 Command 定义

```typescript
// 所有可用的 Command，CLI/MCP/API 共享
interface CommandRegistry {
  // --- Action 执行 ---
  execute_action: (name: string, input: object) => ActionResult
  batch_actions: (actions: Array<{ name: string, input: object }>) => ActionResult[]

  // --- 数据查询 ---
  query: (graphql: string, variables?: object) => QueryResult

  // --- Capability 查询 ---
  list_capabilities: () => Capability[]
  get_capability: (name: string) => CapabilityDetail
  get_schema: (name: string) => SchemaDefinition
  get_actions: (capability: string) => ActionDefinition[]
  get_rules: (capability: string) => RuleDefinition[]
  get_state_machine: (name: string) => StateDefinition
  get_views: (capability: string) => ViewDefinition[]
  get_dependencies: (capability: string) => DependencyGraph

  // --- Execution / Event 查询 ---
  get_execution: (id: string) => Execution
  get_recent_errors: (capability?: string) => ErrorSummary[]

  // --- Proposal ---
  create_proposal: (changes: ProposalChanges) => Proposal
  validate_proposal: (id: string) => ValidationResult
  get_proposal: (id: string) => Proposal
  list_proposals: (filter?: object) => Proposal[]

  // --- 脚手架 ---
  scaffold_capability: (description: string) => GeneratedFiles
  scaffold_rule: (description: string) => GeneratedFiles
  scaffold_action: (description: string) => GeneratedFiles
  scaffold_view: (schema: string, type: string) => GeneratedFiles
}
```

### 2.2 Command 执行流程

```
Command Layer 通过预留插槽（slot）实现管道，具体逻辑由 Capability 填充：

  ┌─ slot: pre ─────────────┐  ← 任何 Capability 可插入（日志、限流等）
  └─────────────────────────┘
              ↓
  ┌─ slot: auth ────────────┐  ← @linchkit/cap-auth 填充（Token 验证 → ctx.actor）
  └─────────────────────────┘    未安装则跳过 → 匿名模式：ctx.actor 为默认匿名 Actor
                                   { type: "system", id: "anonymous", groups: [] }
                                   > auth slot 的实现详见 10a_authentication.md
              ↓
  ┌─ slot: exposure ────────┐  ← 框架内置（接口暴露检查）
  └─────────────────────────┘
              ↓
  ┌─ slot: permission ──────┐  ← @linchkit/cap-permission 填充（权限检查）
  └─────────────────────────┘    未安装则跳过 → 无权限控制：所有 Action 可执行，无数据过滤
              ↓
  ┌─ slot: tenant ──────────┐  ← 多租户 Capability 填充（租户识别 → ctx.tenantId）
  └─────────────────────────┘    未安装则跳过（单租户模式）
              ↓
  ┌─ slot: pre-action ──────┐  ← 任何 Capability 可插入
  └─────────────────────────┘
              ↓
         Action 执行 / GraphQL 查询
              ↓
  ┌─ slot: post-action ─────┐  ← 任何 Capability 可插入
  └─────────────────────────┘
              ↓
         返回结果（根据接口类型过滤字段）

框架核心不依赖任何 Capability。所有 slot 为空时，框架仍可正常运行。
Capability 通过 extensions.middlewares 注册到对应 slot。
想换认证方式？换一个填充 auth slot 的 Capability 即可。
```

### 2.3 统一响应格式

所有通道（HTTP / GraphQL / MCP / CLI）的响应统一遵循此结构：

```typescript
interface CommandResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string                    // 错误码，格式 DOMAIN.CATEGORY.SPECIFIC（详见 33_error_handling.md）
    type: string                    // 错误类别
    message: string                 // 人类可读消息
    details?: object                // 额外信息（字段级错误、Rule 列表等）
  }
  warnings?: string[]
  meta?: {
    executionId?: string
    duration?: number
  }
}
```

### 2.4 REST 请求体约定

**Unwrapped flat body**（参考 Stripe API 设计）—— Body 就是 Action 的 input，不做额外包装。

```
POST /api/actions/submit_request
Headers:
  Authorization: Bearer <token>
  X-Idempotency-Key: uuid-xxx          (可选，幂等 Action)
  X-Execution-Mode: sync | async       (可选，覆盖 Action 默认 policy)
Content-Type: application/json

Body:
{ "id": "pr_001", "amount": 5000 }
```

执行选项（idempotency key、dry-run、async 模式等）通过 HTTP headers 传递，不放入 body。每个通道有自己的元数据传递方式：

| 选项 | HTTP | GraphQL | MCP | CLI |
|------|------|---------|-----|-----|
| Idempotency key | `X-Idempotency-Key` header | mutation variable | tool argument | `--idempotency-key` flag |
| Dry run | `X-Dry-Run: true` header | mutation variable | tool argument | `--dry-run` flag |
| Async override | `X-Execution-Mode` header | mutation variable | tool argument | `--async` flag |

Command Layer adapter 从各通道提取这些选项，注入内部 `ExecutionOptions`：

```typescript
interface ExecuteActionCommand {
  name: string                    // 来自 URL path / mutation name / tool name / CLI arg
  input: object                   // 来自 body / mutation input / tool input / --input flag
  options?: ExecutionOptions      // adapter 从各通道的 headers/flags/variables 中提取
}
```

**设计理由**：Action name 已在 URL path 中，Actor/auth 走 Authorization header，不需要在 body 里再包一层 `{ input: {...}, options: {...} }`。这样 Action 的 input schema 可以直接作为 body 的 JSON Schema，类型映射零摩擦。

### 2.5 HTTP 状态码策略

REST 端使用 HTTP 状态码反映错误类型；GraphQL 端始终 200（per GraphQL spec），错误信息放 `errors[].extensions`。

**错误类型 → HTTP 状态码映射**（详见 [33_error_handling](33_error_handling.md)）：

| 错误类型 | HTTP | 含义 |
|---------|------|------|
| `validation` | 400 | 输入不合法 |
| `not_found` | 404 | Action / 记录 / 资源不存在 |
| `authentication` | 401 | 未登录 / token 过期 |
| `authorization` | 403 | 已认证但无权限 |
| `business_rule` | 422 | 业务规则拦截 |
| `conflict` | 409 | 版本冲突 / 状态冲突 |
| `system` | 500 | 基础设施故障 |

**Action 成功统一返回 200**（不区分 200/201），因为 Action 是命令而非 CRUD 资源创建。

### 2.6 分页格式

列表查询统一使用 offset 分页（适合企业后台表格 + 跳页场景）。

**输入参数**：

```typescript
interface PaginationInput {
  page: number          // 从 1 开始
  pageSize: number      // 每页条数，默认 20
}

interface SortInput {
  field: string
  order: 'ASC' | 'DESC'
}
```

**响应结构**：

```typescript
interface PaginatedResult<T> {
  items: T[]            // 当前页数据
  total: number         // 总记录数
}
```

前端衍生值由客户端计算：`pageCount = Math.ceil(total / pageSize)`、`hasNextPage = page < pageCount`。

此格式在 GraphQL 和 REST 通道保持一致，与 TanStack Table 的 server-side pagination 天然匹配。

> 若未来特定场景（活动流、日志）需要 cursor 分页，可在该 schema 上单独启用 cursor 模式，不影响默认 offset 模式。

### 2.7 认证方式

> 完整认证设计见 [10a_authentication.md](10a_authentication.md)，权限模型见 [10_actor_permission.md](10_actor_permission.md)

#### auth slot 实现

`cap-auth` 使用 **better-auth** 作为底层认证引擎，填充 Command Layer 的 `auth` slot。中间件读取请求中的认证信息，解析为统一的 `Actor` 对象注入 `ctx.actor`：

```typescript
// cap-auth auth slot middleware (simplified)
async function authMiddleware(ctx: CommandContext): Promise<void> {
  const header = ctx.request.headers.get('Authorization')
  const cookie = ctx.request.headers.get('Cookie')

  let actor: Actor

  if (header?.startsWith('Bearer lk_')) {
    // API Key 通道：查找 hashed key → 解析 Actor
    actor = await resolveApiKeyActor(header.slice(7))
  } else if (header?.startsWith('Bearer eyJ')) {
    // JWT 通道：验证 JWT → 从 claims 构造 Actor
    actor = await resolveJwtActor(header.slice(7))
  } else if (cookie) {
    // Session Cookie 通道：better-auth session 验证
    actor = await resolveSessionActor(cookie)
  } else {
    throw new AuthenticationError('No valid credentials provided')
  }

  ctx.actor = actor
}
```

#### 三种认证通道

| 通道 | 认证凭证 | 解析流程 | 适用场景 |
|------|---------|---------|---------|
| **Human** | Session Cookie 或 JWT | better-auth session 验证 → Actor | Web UI 登录用户 |
| **M2M** | `Authorization: Bearer lk_xxx` | SHA-256 hash → 查 `api_keys` 表 → Actor | 服务间调用、CI/CD |
| **AI Agent** | `Authorization: Bearer eyJxxx`（含 agent claims） | JWT 验证 → 检查 `scopes` claim → Actor | MCP / Tool-use 调用 |

#### Actor 解析结果

无论哪种通道，最终产出统一的 `Actor` 对象：

```typescript
// ctx.actor 结构
{
  type: 'human' | 'ai' | 'system' | 'worker' | 'timer' | 'external',
  id: string,
  name?: string,
  groups: string[],        // 权限组，如 ['staff', 'purchase_approver']
  metadata?: {
    // Human: 无特殊字段
    // M2M: { api_key_id, api_key_name }
    // AI Agent: { agent_model, agent_session_id, parent_user_id, scopes }
  },
}
```

#### permission slot 实现

`cap-permission` 填充 `permission` slot，基于 better-auth 的 `createAccessControl` + LinchKit 权限组评估：

- 从 `ctx.actor.groups` 读取权限组列表
- 合并所有权限组的声明（explicit-deny-wins 策略，见 [10_actor_permission.md](10_actor_permission.md) §7.1）
- Action 权限检查：`checkActionPermission(actor, actionName, capabilityName)`
- 数据权限注入：`resolveDataAccess(actor, schemaName, operation)` → 附加到查询条件

## 3. 传输适配器

### 3.1 HTTP API

> HTTP REST 和 GraphQL 由 `cap-adapter-server`（adapter Capability）提供，非 Core 内置。未安装 cap-adapter-server 的应用可以只通过 MCP 或 CLI 调用 CommandLayer。

```
写操作（Action）:
  POST /api/actions/:name           → execute_action（body = action input）
  POST /api/actions/batch           → batch_actions

读操作（GraphQL）:
  POST /api/graphql                 → query

Capability 查询:
  GET /api/capabilities             → list_capabilities
  GET /api/capabilities/:name       → get_capability
  GET /api/schemas/:name            → get_schema

Proposal:
  POST /api/proposals               → create_proposal
  GET  /api/proposals/:id           → get_proposal
  POST /api/proposals/:id/validate  → validate_proposal

系统:
  GET  /api/health                  → 健康检查
  POST /api/auth/login              → execute_action('login')

Webhook:
  POST /api/webhooks/github         → GitHub Webhook 接收
```

### 3.2 MCP

> MCP 由 `cap-adapter-mcp`（adapter Capability）提供，非 Core 内置。

自动将 CommandRegistry 中的所有 Command 注册为 MCP tools：

```typescript
// 自动生成 MCP tool 定义
{
  name: "execute_action",
  description: "执行一个 Action",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Action 名称" },
      input: { type: "object", description: "Action 输入参数" },
    },
    required: ["name", "input"]
  }
}
```

MCP 连接：
```
WebSocket /mcp

认证：
{
  apiKey: "lk_...",
  actorType: "ai",
  actorId: "claude_agent_001"
}
```

### 3.3 CLI

```bash
# Action 执行
linch exec submit_request --input '{"id": "pr_001"}'
linch exec approve_request --id pr_001        # 简写

# GraphQL 查询
linch query '{ purchaseRequests { id title amount status } }'
linch query --file ./queries/monthly_report.graphql

# Capability 查询
linch capabilities list
linch capabilities show purchase_management
linch schema show purchase_request
linch actions list purchase_management
linch rules list purchase_management

# Proposal
linch proposal create --title "Add budget rule" --files rules/budget_check.ts
linch proposal list
linch proposal validate pr_001

# 脚手架
linch scaffold capability "库存管理模块"
linch scaffold rule "采购金额超过5万需要CFO审批"
linch scaffold action "确认收货"
linch scaffold view purchase_request list

# 开发专用（不暴露给 MCP/API）
linch init                      # 初始化项目
linch dev                       # 启动开发服务器
linch generate migration        # 生成 DB migration
linch deploy                    # 手动触发部署
linch introspect --db postgres://...  # introspect 已有数据库
linch health                    # 检查系统健康状态
```

CLI 技术选型：citty（UnJS），轻量、TS 友好。

#### CLI 命令注册机制

CLI 命令分为两类：

**内置命令**（CLI 包自带）：
- `linch init` — 初始化项目
- `linch dev` — 一键启动所有 transports（开发模式）
- `linch exec <action>` — 直接执行 Action
- `linch capabilities list/show` — 查看 capabilities

**Capability 注册命令**（通过 `extensions.commands`）：
- `linch server dev` — cap-adapter-server 注册
- `linch mcp start` — cap-adapter-mcp 注册
- `linch proposal create/list/validate` — 未来 cap-proposal 注册
- `linch scaffold capability/rule/action` — 未来 cap-scaffold 注册

CLI 启动时读取 `linchkit.config.ts`，从 capabilities 的 `extensions.commands` 动态构建命令树。详见 20_extension_mechanism.md §8.6。

## 4. GraphQL 读取层

### 4.1 自动生成

Schema 定义自动生成 GraphQL types + queries：

```
defineSchema('purchase_request', { fields: { ... } })
    ↓ 自动生成
type PurchaseRequest {
  id: ID!
  title: String!
  amount: Float!
  department: Department
  items: [PurchaseItem!]!
  status: String!
  totalAmount: Float
  createdAt: DateTime!
  updatedAt: DateTime!
}

type PurchaseRequestList {
  items: [PurchaseRequest!]!
  total: Int!
}

type Query {
  purchaseRequest(id: ID!): PurchaseRequest
  purchaseRequests(filter: PurchaseRequestFilter, sort: SortInput, pagination: PaginationInput): PurchaseRequestList!
}

# 分页格式见 2.6 节
```

### 4.2 查询能力

```graphql
# 列表 + 筛选 + 排序 + 分页
query {
  purchaseRequests(
    filter: { status: { in: ["submitted"] }, amount: { gt: 10000 } }
    sort: { field: "createdAt", order: DESC }
    pagination: { page: 1, pageSize: 20 }
  ) {
    total
    items {
      id
      title
      amount
      department { name }
      status
    }
  }
}

# 深层关联
query {
  purchaseRequest(id: "pr_001") {
    department {
      manager { name, email }
    }
    items { productName, quantity, subtotal }
  }
}

# 聚合
query {
  purchaseRequestStats(groupBy: "department") {
    department { name }
    count
    totalAmount
  }
}
```

### 4.3 Filter 语法 — DeclarativeCondition

Filter input uses the unified `DeclarativeCondition` format (see `05_rule.md § 4a`), shared across Rules, Views, GraphQL, and saved views.

**GraphQL shorthand** (flat object, operators as nested keys):
```graphql
filter: {
  status: { in: ["submitted", "approved"] }
  amount: { gt: 10000, lte: 100000 }
  createdAt: { gte: "2026-01-01" }
}
```

**Full DeclarativeCondition** (for complex/nested conditions):
```json
{
  "operator": "and",
  "conditions": [
    { "field": "status", "operator": "in", "value": ["submitted"] },
    { "field": "amount", "operator": "gt", "value": 10000 }
  ]
}
```

**REST example** (URL-encoded):
```
GET /api/schemas/purchase_request/list?
    filter={"operator":"and","conditions":[...]}
    stateFilter=submitted
    sort=created_at:desc
    page=1&pageSize=20
```

**State Ribbon shorthand**: `stateFilter=submitted` is equivalent to `{ field: "status", operator: "eq", value: "submitted" }`.

**Saved View Tab queries** (M1+):
```graphql
query {
  viewTabs(schema: "purchase_request") {
    id
    name
    filters    # serialized DeclarativeCondition[]
    sort
    isPersonal
  }
}
```

一套查询语法，五处复用：
- GraphQL filter
- Rule conditions & Context queries
- View defaultFilter & Lens Filter output
- State Ribbon (state click → DeclarativeCondition)
- Saved View configurations

### 4.4 权限自动过滤

GraphQL 查询自动附加当前 Actor 的数据权限，开发者无需手动处理。

### 4.5 N+1 优化

使用 DataLoader 模式，框架自动处理。

### 4.6 技术选型

**graphql-yoga + graphql-js** — code-first GraphQL schema builder（NOT Pothos），通过 graphql-yoga 集成到 Elysia。

## 5. View 层如何使用

```tsx
// useListView 内部：
// 1. 根据 View 定义的 fields 自动生成 GraphQL query
// 2. 通过 Command Layer 的 query command 获取数据
const { data } = useQuery(autoGeneratedGraphQL)

// Action 按钮点击时：
// 通过 Command Layer 的 execute_action command
const result = await executeAction('submit_request', { id: recordId })
```

## 6. 认证

### HTTP API
```
Authorization: Bearer <token>
```

### MCP
```json
{ "apiKey": "lk_...", "actorType": "ai", "actorId": "..." }
```

### CLI
```bash
linch login                     # 交互式登录，token 存本地
linch --token lk_... exec ...   # 或直接传 token
```

## 7. 与里程碑的关系

### M0
- Command Layer 基础框架
- HTTP API（Action RPC + 基础 GraphQL）
- CLI（init, dev, exec, query, capabilities）
- Bearer Token 认证

### M1
- GraphQL 完善（filter / sort / pagination / N+1 优化 / 聚合）
- CLI 完善（proposal, scaffold）
- 权限自动过滤

### M2
- MCP 适配器
- CLI scaffold 命令 + AI 集成
- GraphQL subscriptions（如果需要实时推送）
