# Token 与认证机制设计规范

> Tracking milestones:
> - foundational security architecture reference
>
> Related issues:
> - No dedicated open issue is currently tracked for this spec.
>
> Execution source of truth: GitHub milestones and issues.

> 权限模型详见 [10_actor_permission.md](10_actor_permission.md)
> Command Layer 的 auth slot 详见 [16_command_layer_and_api.md](16_command_layer_and_api.md) §2.2

## 1. 认证架构概述

LinchKit 采用 **Hybrid 认证模式**：短生命周期 JWT（5–15 min）+ server-side session store。

- **better-auth** 作为认证基座，提供 OAuth2/OIDC、Session 管理、Organization 等核心能力
- **cap-auth** 是对 better-auth 的薄封装 Capability，负责填充 Command Layer 的 `auth` slot
- cap-auth 不重新发明认证逻辑，只做：Token 验证 → Actor 构造 → 注入 `ctx.actor`

```
浏览器 / API Client / AI Agent
        │
        ▼
   cap-auth (auth slot)
        │
        ├── better-auth handler（OAuth2/OIDC、session 管理）
        ├── API Key 验证（M2M 场景）
        └── Scoped Bearer Token 验证（AI Agent 场景）
        │
        ▼
   ctx.actor 构造完成，继续 Command Layer 管道
```

## 2. 三种认证通道

| 通道 | 适用场景 | 认证方式 | Token 类型 |
|------|---------|---------|-----------|
| 人类用户 (Browser) | Web UI 登录 | OAuth2/OIDC + Session Cookie | Access Token (JWT) + Refresh Token (httpOnly cookie) |
| 机器 (M2M) | 服务间调用、CI/CD、Webhook | API Key | `lk_` 前缀的静态密钥 |
| AI Agent (MCP/Tool-use) | LLM 工具调用 | Scoped Bearer Token，服务端注入 | 短生命周期 JWT，scope 受限 |

### 2.1 通道选择策略

```
请求进入
  │
  ├── Authorization: Bearer lk_...  → API Key 通道
  ├── Authorization: Bearer eyJ...  → JWT 通道（检查 claims 区分 human/agent）
  └── Cookie: session_id=...        → Session 通道（浏览器）
```

cap-auth 按上述顺序依次尝试，首个匹配的通道生效。

## 3. Token 格式

### 3.1 Access Token (JWT)

短生命周期，默认 15 分钟过期。

```typescript
// JWT Claims
interface AccessTokenClaims {
  sub: string          // Actor ID
  tenant_id: string    // 租户 ID
  groups: string[]     // 权限组列表，如 ['staff', 'purchase_approver']
  iat: number          // 签发时间
  exp: number          // 过期时间（iat + 900s）
  // AI Agent 专属 claims（可选）
  agent_model?: string        // 如 'claude-3.5-sonnet'
  agent_session_id?: string   // Agent 会话 ID
  parent_user_id?: string     // 授权此 Agent 的人类用户 ID
  scopes?: string[]           // 允许的 action/capability 范围
}
```

### 3.2 Refresh Token

- 不透明字符串（非 JWT），服务端存储
- 通过 httpOnly + Secure + SameSite=Strict cookie 传递
- 默认有效期 7 天，滑动续期
- 支持主动吊销（logout 时删除服务端记录）

### 3.3 API Key

```
格式：lk_<256-bit random hex>
示例：lk_a1b2c3d4e5f6...（64 字符 hex）
```

- 至少 256 bits 熵（`crypto.getRandomValues`）
- **只存 hash**：数据库只存储 SHA-256 hash，原始 key 仅在创建时返回一次
- 每个 key 绑定一个 `tenant_id`
- 每个 key 有独立的 `scopes` 和 `metadata`

```typescript
interface ApiKeyRecord {
  id: string
  name: string               // 人类可读标识，如 "CI Pipeline Key"
  key_hash: string           // SHA-256(raw_key)
  key_prefix: string         // 前 8 字符，用于辨识（如 "lk_a1b2"）
  tenant_id: string
  actor_id: string           // 关联的 Actor
  scopes: string[]           // 允许的 capability/action
  expires_at?: Date          // 可选过期时间
  last_used_at?: Date
  created_at: Date
  revoked_at?: Date          // 吊销时间
}
```

## 4. API Key 管理

### 4.1 生命周期

```
创建 → 使用中 → 轮换 → 旧 key grace period → 吊销
```

### 4.2 生成

```typescript
import { randomBytes } from 'crypto'

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const bytes = randomBytes(32) // 256 bits
  const raw = `lk_${bytes.toString('hex')}`
  const hash = sha256(raw)
  const prefix = raw.slice(0, 7) // "lk_a1b2"
  return { raw, hash, prefix }
}
```

创建 API Key 通过 cap-auth 提供的 Action：

```typescript
const result = await executeAction('create_api_key', {
  name: 'CI Pipeline Key',
  scopes: ['purchase_management.*', 'inventory_management.query'],
  expires_at: '2027-01-01T00:00:00Z',
})
// result.data.key = "lk_a1b2c3d4..."  ← 仅此一次返回明文
```

### 4.3 轮换 (Key Rotation)

```typescript
const result = await executeAction('rotate_api_key', {
  key_id: 'key_001',
  grace_period: '24h', // 旧 key 在 24 小时内仍有效
})
// result.data.new_key = "lk_e5f6g7h8..."
// result.data.old_key_expires_at = "2026-03-22T..."
```

轮换时：
1. 生成新 key
2. 旧 key 进入 grace period（默认 24h）
3. Grace period 结束后自动吊销旧 key

### 4.4 Rate Limit

API Key 请求受速率限制，通过 Response headers 通知：

```
X-RateLimit-Limit: 1000        // 窗口内最大请求数
X-RateLimit-Remaining: 950     // 窗口内剩余请求数
X-RateLimit-Reset: 1679616000  // 窗口重置的 Unix 时间戳
```

超出限制返回 HTTP 429。

## 5. better-auth 集成模式（合约/实现分离）

### 5.1 架构分层

认证采用合约/实现分离模式：

```
@linchkit/cap-auth               ← 合约层（纯接口，无第三方依赖）
  ├── AuthProvider 接口            — 定义认证引擎必须实现的方法
  ├── Schema 合约                  — user, session, token, api_key
  ├── Action 签名                  — login, logout, refresh_token, create_api_key, reset_password
  ├── 中间件壳                     — createAuthMiddleware (依赖注入 resolver)
  └── createCapAuth() 工厂         — 组装 provider → 完整 Capability

@linchkit/cap-auth-better-auth   ← 实现层（依赖 better-auth）
  └── createBetterAuthProvider()  — 实现 AuthProvider，委托 better-auth 引擎
```

### 5.2 AuthProvider 接口

```typescript
interface AuthProvider {
  // Action handlers
  login(ctx, input: { email, password }): Promise<LoginResult>
  logout(ctx, input: { session_id? }): Promise<void>
  refreshToken(ctx, input: { refresh_token }): Promise<RefreshResult>
  createApiKey(ctx, input: { name, scopes?, expires_at? }): Promise<CreateApiKeyResult>
  resetPassword(ctx, input: { email?, token?, new_password? }): Promise<ResetPasswordResult>

  // Token/credential resolution (used by auth middleware)
  resolveToken(token: string): Promise<Actor | null>
  resolveApiKey(key: string): Promise<Actor | null>
  resolveSession(sessionId: string): Promise<Actor | null>
}
```

### 5.3 组装方式

```typescript
import { createCapAuth } from '@linchkit/cap-auth'
import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'

// 1. 创建 better-auth provider
const provider = createBetterAuthProvider({
  auth: betterAuth({
    database: drizzleAdapter(db),
    plugins: [organization()],
    session: { expiresIn: 60 * 15, updateAge: 60 * 5 },
  }),
})

// 2. 组装完整的 cap-auth（action handlers + middleware 均已连接）
const capAuth = createCapAuth({ provider })
```

### 5.4 better-auth Elysia 集成

cap-auth-better-auth 内部使用 better-auth 的 Elysia 集成 + macro 模式：

```typescript
// cap-auth-better-auth 内部实现（M1）
const betterAuthPlugin = new Elysia({ name: 'better-auth' })
  .mount(auth.handler)
  .macro({
    auth: {
      async resolve({ status, request: { headers } }) {
        const session = await auth.api.getSession({ headers })
        if (!session) return status(401)
        return { user: session.user, session: session.session }
      },
    },
  })
```

cap-auth-better-auth 在 better-auth 基础上增加：
- API Key 验证逻辑（检查 `Authorization: Bearer lk_...` 前缀）
- Actor 构造（将 better-auth session / API Key record 转换为 `Actor` 对象）
- JWT claims 中的 `groups[]` 注入

### 5.5 可替换性

由于 cap-auth 是纯合约，未来可创建其他 provider：
- `cap-auth-lucia` — 使用 Lucia 作为认证引擎
- `cap-auth-custom` — 自研认证逻辑
- Mock provider — 测试用

## 6. AI Agent 认证

### 6.1 核心原则

**Agent 不决定自己的权限，平台注入。**

AI Agent 的权限由授权它的人类用户（或系统管理员）决定。Agent 只在被授予的 scope 范围内操作。

### 6.2 MCP 认证

MCP (Model Context Protocol) 使用 **OAuth 2.1** 标准流程：

```
LLM Host (Claude Desktop 等)
    │
    ├── 1. OAuth 2.1 Authorization Code + PKCE
    │      → cap-auth /oauth/authorize
    │      → 用户在浏览器中确认授权范围
    │      → 回调获取 authorization code
    │
    ├── 2. Exchange code for tokens
    │      → cap-auth /oauth/token
    │      → 获取 scoped access token
    │
    └── 3. MCP 连接建立
           → Bearer token 附在每个请求
           → cap-auth 验证 + 构造 Actor
```

### 6.3 Actor 扩展字段

AI Agent 的 Actor 包含额外字段，用于审计追踪和行为约束：

```typescript
interface AgentActorMetadata {
  agent_model: string          // 模型标识，如 'claude-3.5-sonnet'
  agent_session_id: string     // 会话唯一标识
  parent_user_id: string       // 授权此 Agent 的人类用户 ID
  scopes: string[]             // 允许的操作范围
}

// 示例 Actor
const agentActor: Actor = {
  type: 'ai',
  id: 'agent_session_abc123',
  name: 'Claude Agent',
  groups: ['ai_agent'],        // 权限组
  metadata: {
    agent_model: 'claude-3.5-sonnet',
    agent_session_id: 'sess_abc123',
    parent_user_id: 'user_001',  // 张三授权的
    scopes: ['purchase_management.create_request', 'purchase_management.submit_request'],
  },
}
```

### 6.4 Scope 检查

Agent 的权限取两者交集：
- Agent 被授予的 `scopes`（token 中）
- Agent 所属权限组（`groups`）的权限

```
最终权限 = scopes ∩ groups_permissions
```

即使权限组允许某操作，若 token scope 未包含，也不能执行。

## 7. 安全考量

### 7.1 Token 存储

| Token 类型 | 存储位置 | 安全措施 |
|-----------|---------|---------|
| Access Token (JWT) | 内存 / sessionStorage | 短过期时间，不存 localStorage |
| Refresh Token | httpOnly cookie | Secure + SameSite=Strict |
| API Key (raw) | 客户端安全存储 | 仅创建时返回，服务端只存 hash |

### 7.2 Token 吊销

- Access Token：短过期即自然失效；紧急情况通过 blocklist 强制吊销
- Refresh Token：删除服务端记录即失效
- API Key：设置 `revoked_at` 即失效

### 7.3 CSRF 防护

浏览器通道使用 Cookie 认证时，需 CSRF 防护：
- better-auth 内置 CSRF token 机制
- 所有写操作要求 `Content-Type: application/json`（浏览器 form 无法伪造）

## 8. 与里程碑的关系

### M0
- Actor 基础类型定义（`Actor` interface）
- Command Layer `auth` slot 类型定义（预留接口）
- 开发模式下使用硬编码 Actor（跳过认证）

### M1
- better-auth 集成 + cap-auth Capability 实现
- 浏览器通道：OAuth2/OIDC + Session Cookie
- API Key 生成、验证、吊销
- JWT claims 中的 `groups[]` + `tenant_id`
- Rate Limit 基础实现

### M2
- AI Agent OAuth 2.1 + MCP 认证
- Scoped Bearer Token
- Agent scope 交集计算
- API Key 轮换 + grace period
- 完整审计追踪（所有认证事件）
