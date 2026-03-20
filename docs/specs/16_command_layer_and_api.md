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
  └─────────────────────────┘    未安装则跳过（匿名模式）
              ↓
  ┌─ slot: exposure ────────┐  ← 框架内置（接口暴露检查）
  └─────────────────────────┘
              ↓
  ┌─ slot: permission ──────┐  ← @linchkit/cap-permission 填充（权限检查）
  └─────────────────────────┘    未安装则跳过（无权限控制）
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

框架不实现认证/权限/租户的具体逻辑，只预留插槽。
Capability 通过 extensions.middlewares 注册到对应 slot。
想换认证方式？换一个填充 auth slot 的 Capability 即可。
```

### 2.3 统一响应格式

```typescript
interface CommandResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    details?: object
  }
  warnings?: string[]
  meta?: {
    executionId?: string
    duration?: number
  }
}
```

## 3. 传输适配器

### 3.1 HTTP API

```
写操作（Action）:
  POST /api/actions/:name           → execute_action
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

type Query {
  purchaseRequest(id: ID!): PurchaseRequest
  purchaseRequests(filter: PurchaseRequestFilter, sort: SortInput, pagination: PaginationInput): PurchaseRequestList!
}
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

### 4.3 Filter 语法

复用 MongoDB 风格，与 Rule Context 查询语法统一：

```graphql
filter: {
  status: { in: ["submitted", "approved"] }
  amount: { gt: 10000, lte: 100000 }
  createdAt: { gte: "2026-01-01" }
}
```

一套查询语法，三处复用：
- GraphQL filter
- Rule Context 查询
- View 的 filter 定义

### 4.4 权限自动过滤

GraphQL 查询自动附加当前 Actor 的数据权限，开发者无需手动处理。

### 4.5 N+1 优化

使用 DataLoader 模式，框架自动处理。

### 4.6 技术选型

**graphql-yoga + Pothos** — code-first GraphQL schema builder，通过 @elysiajs/graphql-yoga 集成到 Elysia。

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
