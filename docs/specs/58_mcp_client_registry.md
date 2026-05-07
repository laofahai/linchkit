# MCP Client Registry — AI Agent 接入管理

> 本 spec 扩展 [Spec 15 — AI Developer Experience](./15_ai_developer_experience.md) §3 和 [Spec 20 — Extension Mechanism](./20_extension_mechanism.md) §8.5。
> Spec 15 定义了 MCP 工具集（查询、操作、Proposal），Spec 20 定义了 transport 注册机制。本 spec 补充 **Client 注册、per-client 授权、工具可见性策略、使用统计** 以及配套管理 UI。

> Status: Draft | Date: 2026-04-03
> Milestone: M2
> Addon group: `adapter-mcp`
> Capabilities: `@linchkit/cap-adapter-mcp` (enhance), `@linchkit/cap-mcp-ui` (new)

## 1. 问题

当前 MCP 实现：
- 单个 Bearer Token，所有 Client 共享
- 硬编码 Actor `{ type: "ai", id: "mcp-client", groups: ["ai_agent"] }`
- 无法区分不同 AI Agent 的权限（Claude Desktop vs 自动化脚本 vs 第三方）
- 无法控制每个 Client 可见的工具集
- 无使用量追踪和审计

生产环境需要：多个 AI Agent 接入，各自有不同权限、不同工具可见范围、独立的审计追踪。

## 2. 设计原则

### 2.1 Capability，不是 Core

MCP Client Registry 是 `cap-adapter-mcp` 的增强，不进 Core。没有 MCP 的 LinchKit 仍然完整。

### 2.2 向后兼容

单 Bearer Token 模式保留为 **simple mode**（开发/demo）。Client Registry 为 **registry mode**。配置决定模式：

```typescript
// simple mode（现有行为）
{ bearerToken: "sk-xxx" }

// registry mode（新增）
{ clientRegistry: { enabled: true, storage: "database" } }

// 两者共存：simple token 作为 fallback
{ bearerToken: "sk-xxx", clientRegistry: { enabled: true } }
```

### 2.3 CommandLayer 复用

Client 管理操作（CRUD）本身就是 Action，走 CommandLayer pipeline。权限通过现有 permission slot 控制。

## 3. 数据模型

### 3.1 McpClient

```typescript
interface McpClient {
  id: string;                    // ULID
  name: string;                  // Human-readable: "Claude Desktop", "CI Bot"
  description?: string;
  
  // Auth
  clientId: string;              // 公开标识符（如 "claude-desktop-prod"）
  secretHash: string;            // bcrypt hash of client secret
  
  // Actor Mapping
  actorType: "ai" | "service";   // Actor.type
  actorId: string;               // Actor.id（默认 = clientId）
  actorName: string;             // Actor.name（默认 = name）
  actorGroups: string[];         // Actor.groups（默认 ["ai_agent"]）
  
  // Tool Policy
  toolPolicy: ToolPolicy;
  
  // Metadata
  enabled: boolean;              // 可禁用而不删除
  expiresAt?: Date;              // 可选过期时间
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ToolPolicy {
  mode: "allow_all" | "allowlist" | "denylist";
  tools: string[];               // tool names
  // 按类别控制（互补 tools 精确列表）
  categories?: {
    introspection: boolean;      // list_schemas, describe_schema, ...
    query: boolean;              // GraphQL query proxy
    actions: boolean;            // 动态 Action tools
    ai_security: boolean;        // check_ai_boundary, ...
    scaffold: boolean;           // scaffold_* tools
    ontology: boolean;           // ontology_overview, search_ontology
    docs: boolean;               // get_capability_docs, search_docs
    management: boolean;         // Client 管理工具（仅 admin）
  };
}
```

### 3.2 System Table

```typescript
// _linchkit_mcp_clients
const mcpClientsTable = pgTable("_linchkit_mcp_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  client_id: text("client_id").notNull().unique(),
  secret_hash: text("secret_hash").notNull(),
  actor_type: text("actor_type").notNull().default("ai"),
  actor_id: text("actor_id").notNull(),
  actor_name: text("actor_name").notNull(),
  actor_groups: jsonb("actor_groups").notNull().default(["ai_agent"]),
  tool_policy: jsonb("tool_policy").notNull().default({ mode: "allow_all", tools: [] }),
  enabled: boolean("enabled").notNull().default(true),
  expires_at: timestamp("expires_at"),
  last_used_at: timestamp("last_used_at"),
  created_at: timestamp("created_at").notNull().defaultNow(),
  updated_at: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  _schema: { schema: "_linchkit" },
}));
```

### 3.3 Usage Log（轻量）

不新建表。复用 `_linchkit.executions` — MCP 请求通过 CommandLayer 执行时已自动记录。`actor.id` 字段区分不同 Client。

GraphQL 查询代理（`query` tool）的使用通过 EventBus emit `mcp.query` 事件，被 `_linchkit.events` 捕获。

## 4. 认证流程

### 4.1 Token 格式

```
Authorization: Bearer <clientId>:<clientSecret>
```

SSE 传输在 HTTP header 中携带。Stdio 传输通过 init message 的 meta 字段传递。

### 4.2 Resolution 流程

```
Token received
  │
  ├─ registry mode?
  │   ├─ parse clientId:secret
  │   ├─ lookup McpClient by clientId
  │   ├─ verify secret (bcrypt)
  │   ├─ check enabled && !expired
  │   ├─ update lastUsedAt
  │   └─ return Actor from McpClient mapping
  │
  └─ simple mode (fallback)?
      ├─ compare token === bearerToken
      └─ return default MCP_ACTOR
```

```typescript
// McpClientRegistry
class McpClientRegistry {
  async resolveActor(token: string): Promise<Actor | null> {
    // 1. Try registry mode
    if (this.registryEnabled) {
      const [clientId, secret] = parseToken(token);
      if (clientId && secret) {
        const client = await this.store.findByClientId(clientId);
        if (client && client.enabled && !this.isExpired(client)) {
          const valid = await verifySecret(secret, client.secretHash);
          if (valid) {
            await this.store.touchLastUsed(client.id);
            return {
              type: client.actorType,
              id: client.actorId,
              name: client.actorName,
              groups: client.actorGroups,
            };
          }
        }
        return null; // Invalid credentials
      }
    }
    
    // 2. Fallback to simple bearer token
    if (this.simpleBearerToken && token === this.simpleBearerToken) {
      return MCP_ACTOR; // Default actor
    }
    
    return null;
  }
}
```

### 4.3 Tool Filtering

认证完成后，根据 Client 的 `toolPolicy` 过滤可用工具：

```typescript
function filterTools(
  allTools: McpTool[],
  policy: ToolPolicy,
): McpTool[] {
  if (policy.mode === "allow_all") return allTools;
  
  return allTools.filter(tool => {
    // Category-level check
    if (policy.categories) {
      const cat = getToolCategory(tool.name);
      if (cat && policy.categories[cat] === false) return false;
    }
    
    // Exact tool-level check
    if (policy.mode === "allowlist") return policy.tools.includes(tool.name);
    if (policy.mode === "denylist") return !policy.tools.includes(tool.name);
    return true;
  });
}
```

MCP SDK 的 `server.setRequestHandler(ListToolsRequestSchema, ...)` 在返回前过滤。`server.setRequestHandler(CallToolRequestSchema, ...)` 在执行前再次校验（defense in depth）。

## 5. GraphQL Extensions

`cap-adapter-mcp` 通过 `graphqlExtensions` 暴露管理 API：

```typescript
// Query
type McpClient {
  id: ID!
  name: String!
  description: String
  clientId: String!
  actorType: String!
  actorId: String!
  actorName: String!
  actorGroups: [String!]!
  toolPolicy: JSON!
  enabled: Boolean!
  expiresAt: DateTime
  lastUsedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
}

type McpUsageStats {
  clientId: String!
  totalRequests: Int!
  last24h: Int!
  last7d: Int!
  topTools: [ToolUsage!]!
}

type Query {
  mcpClients(enabled: Boolean): [McpClient!]!
  mcpClient(id: ID!): McpClient
  mcpUsageStats(clientId: String!, period: String): McpUsageStats
}

// Mutation
type McpClientCredentials {
  clientId: String!
  clientSecret: String!   # Only returned on create/rotate
}

type Mutation {
  createMcpClient(input: CreateMcpClientInput!): McpClientCredentials!
  updateMcpClient(id: ID!, input: UpdateMcpClientInput!): McpClient!
  deleteMcpClient(id: ID!): Boolean!
  rotateMcpClientSecret(id: ID!): McpClientCredentials!
  toggleMcpClient(id: ID!, enabled: Boolean!): McpClient!
}
```

## 6. Management MCP Tools

Client Registry 自身也暴露为 MCP 工具（仅 admin Client 可用，通过 `categories.management` 控制）：

```typescript
// 让有权限的 AI Agent 自助管理其他 Client
const managementTools = [
  { name: "mcp_list_clients", description: "List registered MCP clients" },
  { name: "mcp_create_client", description: "Register a new MCP client" },
  { name: "mcp_update_client", description: "Update client config (tool policy, actor mapping)" },
  { name: "mcp_toggle_client", description: "Enable/disable a client" },
  { name: "mcp_rotate_secret", description: "Rotate client secret" },
  { name: "mcp_usage_stats",   description: "Get usage statistics for a client" },
];
```

## 7. UI — cap-mcp-ui

### 7.1 Capability 定义

```typescript
export const capMcpUi = defineCapability({
  name: "cap-mcp-ui",
  label: "MCP Management UI",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "adapter-mcp",
  dependencies: ["cap-adapter-ui", "cap-adapter-mcp"],
  autoInstall: true,
});
```

### 7.2 Admin Route Registration

需要 adapter-ui 新增 **Route Registry**（panel-registry 的同级机制）：

```typescript
// cap-adapter-ui/src/lib/route-registry.ts
interface AdminRouteRegistration {
  id: string;
  capability: string;
  path: string;               // e.g. "/admin/mcp"
  label: string;              // i18n key
  icon?: string;              // Lucide icon
  order?: number;
  component: () => Promise<{ default: React.ComponentType }>;
  children?: AdminRouteRegistration[]; // Sub-routes
}

export function registerAdminRoute(route: AdminRouteRegistration): void;
export function getAdminRoutes(): AdminRouteRegistration[];
```

### 7.3 Pages

```typescript
// cap-mcp-ui/src/index.ts
import { registerAdminRoute } from "@linchkit/cap-adapter-ui/route-registry";

registerAdminRoute({
  id: "mcp",
  capability: "cap-adapter-mcp",
  path: "/admin/mcp",
  label: "mcp.admin.title",
  icon: "Plug",
  order: 300,
  component: () => import("./pages/mcp-dashboard"),
  children: [
    {
      id: "mcp-clients",
      capability: "cap-adapter-mcp",
      path: "/admin/mcp/clients",
      label: "mcp.admin.clients",
      component: () => import("./pages/mcp-clients"),
    },
    {
      id: "mcp-client-detail",
      capability: "cap-adapter-mcp",
      path: "/admin/mcp/clients/:id",
      label: "mcp.admin.clientDetail",
      component: () => import("./pages/mcp-client-detail"),
    },
  ],
});
```

### 7.4 UI 功能

| Page | 内容 |
|------|------|
| **Dashboard** `/admin/mcp` | 活跃 Client 数、24h 请求量图表、最近调用列表、健康状态 |
| **Client List** `/admin/mcp/clients` | 表格：name, clientId, enabled, lastUsedAt, 请求量。支持创建/删除 |
| **Client Detail** `/admin/mcp/clients/:id` | 基本信息编辑、Actor mapping 配置、Tool Policy 配置（category toggle + 精确 tool 列表）、Secret 轮换（显示一次）、Usage 图表 |

### 7.5 Tool Policy Editor

核心 UI 组件 — 可视化配置工具可见性：

```
┌─ Tool Policy ─────────────────────────────┐
│ Mode: ○ Allow All  ● Categories  ○ Custom │
│                                           │
│ Categories:                               │
│ ☑ Introspection (list_schemas, ...)      │
│ ☑ Query (GraphQL proxy)                  │
│ ☑ Actions (dynamic action tools)         │
│ ☐ AI Security                            │
│ ☐ Scaffold                               │
│ ☑ Ontology                               │
│ ☑ Docs                                   │
│ ☐ Management (admin only)                │
│                                           │
│ Additional exclusions:                    │
│ [execute_action_delete_purchase] [x]      │
└───────────────────────────────────────────┘
```

## 8. 实现范围

### cap-adapter-mcp 修改

| 文件 | 变更 |
|------|------|
| `src/client-registry.ts` | **新建** — McpClientRegistry class, store interface |
| `src/client-store-drizzle.ts` | **新建** — Drizzle 实现（PostgreSQL） |
| `src/client-store-memory.ts` | **新建** — InMemory 实现（开发/测试） |
| `src/system-tables.ts` | **新建** — `_linchkit_mcp_clients` 表定义 |
| `src/graphql.ts` | **新建** — GraphQL extension（queries + mutations） |
| `src/management-tools.ts` | **新建** — MCP management tools |
| `src/mcp-server.ts` | **修改** — 注入 ClientRegistry，tool filtering，actor resolution |
| `src/sse-transport.ts` | **修改** — 使用 ClientRegistry 替代简单 token 比较 |
| `src/capability.ts` | **修改** — 添加 graphqlExtensions, 系统表注册 |
| `src/config.ts` | **修改** — 新增 clientRegistry 配置 |

### cap-mcp-ui 新建

| 文件 | 说明 |
|------|------|
| `src/capability.ts` | Capability 定义 |
| `src/index.ts` | 入口 + route 注册 |
| `src/pages/mcp-dashboard.tsx` | Dashboard page |
| `src/pages/mcp-clients.tsx` | Client list page |
| `src/pages/mcp-client-detail.tsx` | Client detail + tool policy editor |
| `src/components/tool-policy-editor.tsx` | Tool policy visual editor |
| `src/i18n/en.json` | English translations |
| `src/i18n/zh-CN.json` | Chinese translations |

### cap-adapter-ui 修改

| 文件 | 变更 |
|------|------|
| `src/lib/route-registry.ts` | **新建** — Admin route registry（panel-registry 同级） |
| `src/pages/admin-layout.tsx` | **修改** — 消费 route registry，渲染 admin 导航和路由 |

## 9. 依赖关系

```
cap-adapter-mcp (enhanced)
  ├── @linchkit/core (types, CommandLayer)
  ├── @modelcontextprotocol/sdk
  └── bcrypt (secret hashing)

cap-mcp-ui (new)
  ├── cap-adapter-ui (UI shell, route registry)
  └── cap-adapter-mcp (backend, autoInstall trigger)
```

## 10. 安全考虑

- **Secret 只显示一次**：创建/轮换时返回明文，之后只存 hash
- **bcrypt**：secret hash 使用 bcrypt（cost factor 12）
- **Rate limiting**：认证失败的请求受 CommandLayer pre slot 的 rate limiter 约束
- **Audit**：所有管理操作（create/update/delete/rotate）通过 CommandLayer 执行，自动产生 execution log
- **Token 格式**：`clientId:secret` 格式让服务端可以先查 client 再验 secret，避免 timing attack（bcrypt 本身已抗时序攻击）
- **过期机制**：`expiresAt` 可选，过期后自动拒绝（不需要定时清理）
