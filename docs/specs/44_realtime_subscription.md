# 实时数据订阅

> Status: Draft | Date: 2026-03-23
> 灵感来源: Palantir OSDK Subscriptions（WebSocket 对象集变更通知）
> 里程碑: M2

## 1. 问题

当前 UI↔Server 通信仅支持请求-响应模式（REST + GraphQL）。当数据发生变化（其他用户编辑、EventHandler 触发、Flow 步骤完成）时，UI 无法感知，直到用户手动刷新。

导致：
- 并发编辑后显示过期数据
- 审批/驳回发生后没有实时反馈
- 没有实时协作感知
- 只能靠轮询作为权宜之计（浪费资源、有延迟）

## 2. 方案：Server-Sent Events (SSE) 订阅

新增 SSE 端点，向已连接的客户端推送数据变更通知。客户端订阅特定 Schema 或记录，当数据变更时接收事件。

**为什么选 SSE 而非 WebSocket：**
- 更简单（单向、HTTP 原生、`EventSource` 内置自动重连）
- 不需要特殊配置即可穿透代理和负载均衡
- 满足当前需求（server→client 通知；client→server 继续使用 REST/GraphQL）
- Elysia 原生支持 SSE
- 需要双向通信时可升级到 WebSocket

## 3. 架构

```
Client (UI)                          Server (Elysia)
    │                                     │
    ├── GET /api/subscribe ────────────►  SSE 端点
    │   Headers: Authorization, Accept    │
    │                                     │
    │  ◄──── event: schema.changed ──────┤
    │  ◄──── event: record.updated ──────┤  ← EventBus 监听器
    │  ◄──── event: record.created ──────┤
    │  ◄──── event: record.deleted ──────┤
    │  ◄──── event: state.changed  ──────┤
    │  ◄──── event: approval.resolved ───┤
    │                                     │
    │  （断线自动重连）                      │
    └─────────────────────────────────────┘
```

## 4. 订阅 API

### 4.1 服务端端点

```
GET /api/subscribe?schemas=purchase_request,inventory_item
GET /api/subscribe?schemas=purchase_request&ids=pr_001,pr_002
GET /api/subscribe  （订阅用户有读权限的所有 Schema）
```

查询参数：
- `schemas` — 逗号分隔的 Schema 名称
- `ids` — 逗号分隔的记录 ID，用于细粒度订阅（可选）

### 4.2 事件格式

```typescript
// SSE 事件格式
interface SubscriptionEvent {
  type: 'record.created' | 'record.updated' | 'record.deleted'
      | 'state.changed' | 'approval.resolved' | 'schema.changed'

  schema: string           // 如 "purchase_request"
  recordId: string         // 受影响的记录 ID
  tenantId: string         // 租户范围

  // 部分数据（仅变更字段，不是完整记录）
  changes?: Record<string, unknown>

  // 状态迁移信息（仅 state.changed）
  state?: { from: string; to: string; action: string }

  // 元数据
  actor: { id: string; type: string }
  timestamp: string        // ISO 8601
  executionId?: string     // 追溯到执行日志
}
```

### 4.3 客户端 Hook

```typescript
import { useSubscription } from '@linchkit/cap-adapter-ui'

function PurchaseRequestList() {
  const { data, refetch } = useSchemaData('purchase_request')

  // 数据变更时自动重新获取
  useSubscription({
    schemas: ['purchase_request'],
    onEvent: (event) => {
      if (event.type === 'record.created' || event.type === 'record.updated') {
        refetch()  // 或基于 event.changes 做乐观更新
      }
    },
  })

  return <AutoList data={data} />
}
```

### 4.4 单条记录订阅

```typescript
function PurchaseRequestForm({ id }: { id: string }) {
  const { data, refetch } = useRecordData('purchase_request', id)

  useSubscription({
    schemas: ['purchase_request'],
    ids: [id],
    onEvent: (event) => {
      if (event.type === 'state.changed') {
        // 显示 toast："状态已变更为：approved"
        toast(`状态: ${event.state?.from} → ${event.state?.to}`)
        refetch()
      }
      if (event.type === 'approval.resolved') {
        toast('审批结果已返回')
        refetch()
      }
    },
  })

  return <AutoForm data={data} />
}
```

## 5. 服务端实现

### 5.1 cap-adapter-server 中的 SSE 端点

```typescript
// Elysia 服务器设置
app.get('/api/subscribe', async function* ({ query, request }) {
  const { schemas, ids } = parseSubscriptionQuery(query)
  const actor = extractActor(request)  // 从 auth 中间件获取

  // 过滤：仅用户有读权限的 Schema
  const allowedSchemas = filterByPermission(schemas, actor)

  // 创建每连接的事件流
  const stream = createSubscriptionStream({
    schemas: allowedSchemas,
    ids: ids ?? undefined,
    tenantId: actor.tenantId,
  })

  // 有事件到来时 yield
  for await (const event of stream) {
    yield event
  }
})
```

### 5.2 与 EventBus 集成

订阅系统监听现有 EventBus（不是单独的数据通道）：

```typescript
function createSubscriptionStream(filter: SubscriptionFilter): AsyncIterable<SubscriptionEvent> {
  // 注册 EventBus 监听器，监听相关事件：
  //   action.succeeded → 映射为 record.created/updated/deleted
  //   state.transition  → 映射为 state.changed
  //   approval.resolved → 映射为 approval.resolved
  //
  // 按 Schema 名称、记录 ID、tenant_id 过滤
  // 转换为 SubscriptionEvent 格式
  // yield 到 SSE 流
}
```

### 5.3 连接管理

| 关注点 | 方案 |
|--------|------|
| 每用户最大连接数 | 3（可配置） |
| 心跳 | 每 30 秒（`:keepalive` 注释） |
| 空闲超时 | 5 分钟无订阅活动 → 关闭 |
| 重连 | 客户端 `EventSource` 自动重连；服务端支持 `Last-Event-ID` |
| 背压 | 客户端缓冲区超过 100 个事件时丢弃（记录警告） |

## 6. 权限执行

- 订阅遵循与 REST/GraphQL 读操作相同的权限模型
- 用户仅接收有读权限的 Schema/记录的事件
- `tenant_id` 过滤是强制的（和所有其他查询一样）
- 连接期间权限被撤销时，后续事件被过滤掉

## 7. 不做什么

- **不在事件中发送完整记录数据** — 发送 `recordId` + `changes`（部分数据）。客户端需要完整数据时通过现有 API 获取。避免权限绕过并减少带宽。
- **不实现自定义 pub/sub** — 使用现有 `EventBus` 作为事件源。SSE 只是其上的传输层。
- **不通过 SSE 支持写操作** — SSE 仅限 server→client。写操作继续通过 REST/GraphQL/Action。
- **不急着做 WebSocket** — SSE 更简单且够用。仅在出现双向需求时（如协同编辑）升级到 WebSocket。

## 8. 配置

```typescript
// linchkit.config.ts
export default defineConfig({
  subscription: {
    enabled: true,                    // 默认: true（有 server capability 时）
    maxConnectionsPerUser: 3,         // 默认: 3
    heartbeatInterval: 30_000,        // ms, 默认: 30s
    idleTimeout: 300_000,             // ms, 默认: 5min
    maxBufferSize: 100,               // 每连接缓冲区最大事件数
  },
})
```

## 9. 与现有 Spec 的关系

| Spec | 关系 |
|------|------|
| 07_event | SSE 事件源自 spec 07 定义的领域事件 |
| 08_event_handler | SSE 监听 EventHandler 使用的同一个 EventBus |
| 13_view_and_ui | UI Hook 消费 SSE 事件实现实时更新 |
| 16_command_layer_and_api | SSE 端点遵循相同的认证管道 |
| 30_multi_tenancy | 事件按 tenant_id 过滤 |

## 10. 里程碑

### M2
- SSE 端点（`/api/subscribe`）— cap-adapter-server
- `useSubscription` Hook — cap-adapter-ui
- Schema 级别订阅（订阅某个 Schema 的所有变更）
- 与现有数据 Hook 集成自动 refetch
- 心跳 + 重连
- 权限过滤

### M3
- 记录级别订阅（订阅特定记录 ID）
- `Last-Event-ID` 支持，断线重连时回放
- 基于 `event.changes` 的乐观 UI 更新（无需 refetch）
- 协作感知（谁还在查看这条记录）
