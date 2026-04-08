# Chatter — 统一记录时间线

> 本 spec 扩展 [Spec 14 — System Capabilities](./14_system_capabilities.md) 4.7。请先阅读该 spec。
> Spec 14 列出 `@linchkit/cap-comment` 作为"建议安装"的系统 Capability，提供评论/活动功能。本 spec 提供 `@linchkit/cap-chatter` 的**完整设计**，定位从"聊天+活动日志"升级为**统一记录级时间线**，涵盖字段级变更审计、执行日志、人工评论、AI 对话、状态流转和可观测性数据。

> Status: Draft | Date: 2026-03-27
> Milestone: M3 (post-M2)
> Capability: `@linchkit/cap-chatter` (supersedes `@linchkit/cap-comment` from spec 14)

## 1. 问题

业务应用需要在记录级别进行上下文协作和审计。用户需要：

- 在采购申请表单页面上直接讨论
- 查看审计追踪：谁在何时修改了哪些字段、从什么值改为什么值
- 查看该记录的 Action 执行历史
- @提及同事以引起关注
- 附加文件到讨论中
- 在关注的记录更新时收到通知
- 查看 AI 对话和洞察（依赖 `cap-ai`）
- 查看状态流转历史
- 关联该记录的可观测性数据（traces、metrics）

没有统一时间线，这些信息分散在多个面板和外部工具中，上下文丢失，审计追踪不可见。

### 1.1 与现有组件的关系

| 现有组件 | 关系 |
|---------|------|
| **ActivityPanel** | 被 ChatterPanel **替代**（ChatterPanel 是其功能超集） |
| **VersionHistoryPanel** | **保持独立**（版本快照 + 恢复是不同关注点） |
| **ExecutionLogger** | 作为 Chatter auto-log 条目的**数据来源** |
| **Observability (Spec 28)** | Metrics/traces 可选择性地注入到 Chatter 时间线 |

## 2. 设计原则

### 2.1 统一记录时间线（Unified Record Timeline）

Chatter **不仅仅是聊天功能**。它是统一的记录级时间线，整合以下数据流：

1. **字段级变更审计** — 谁修改了哪个字段、何时、从什么值改为什么值
2. **执行日志** — 该记录的 Action 执行历史
3. **人工评论和备注** — 用户讨论和内部备注
4. **AI 对话和洞察** — AI 分析结果和对话记录（依赖 `cap-ai`）
5. **状态流转** — 状态机迁移历史
6. **可观测性数据** — 关联的 traces、metrics（可选，来自 Spec 28）

所有这些在一条时间线上按时间顺序呈现，支持按类型筛选。

### 2.2 Capability，不是 Core

Chatter 是 Capability（`@linchkit/cap-chatter`），**不是** `@linchkit/core` 的一部分。Core 保持最小化。Capability 通过 `extensions` 注册系统表、GraphQL 类型和 UI 组件。

唯一的 Core 前置变更：确保 EventBus 的 `record.updated` 事件携带字段 diff 数据（见 3.1 节）。

这遵循 [Spec 14](./14_system_capabilities.md) 2 的架构 — 系统功能作为官方 Capability 包交付，而非框架硬编码。Chatter 通过弱依赖与其他系统 Capability 集成（见 spec 14 5）：
- `cap-auth` — 用户解析用于 @提及和作者显示（可选；无 auth 时使用匿名 actor）
- `cap-ai` — AI 对话和洞察功能（可选；无 AI 时隐藏 AI 相关功能）
- `cap-notification` — 通知投递（可选；内置 in-app 通知，cap-notification 添加更多渠道）
- `cap-file-storage` — 附件存储后端（可选；chatter 自带附件存储）

其他 Capability 不需要感知 Chatter 的存在 — Chatter 通过 EventBus 订阅事件，完全解耦。

**设计理由：** 不是所有部署都需要协作功能（如 headless API、纯 MCP agent）。安装 `cap-chatter` 即启用；卸载即干净移除。

### 2.3 与 Core 边界审计的交叉引用

以下功能目前在 core 中，应迁移为 Capability：

| 功能 | 目标 Capability | Chatter 关系 |
|------|----------------|-------------|
| AI 功能 | `cap-ai` | Chatter 的 AI 对话依赖此 Capability |
| Automation | `cap-automation` | Chatter auto-log 使用 EventBus，不使用 automation engine |
| Flow | `cap-flow` | 无直接关系 |
| Approval | `cap-approval` | 审批事件可产生 Chatter log 条目 |

这进一步验证了 Chatter 作为 Capability 的正确性。

### 2.4 灵感来源

| 系统 | 借鉴的关键思路 |
|------|--------------|
| **Odoo Chatter** | 每条记录上的统一消息流；日志 vs. 评论；关注者模型；状态变更自动记录 |
| **Salesforce Chatter** | 带类型化载荷的 Feed Item；@提及解析到用户；富文本内容 |
| **GitHub Issues/PRs** | 时间线模型（评论 + 事件交错）；Reactions；线程回复 |

### 2.5 单表，全 Schema

消息存储在一张中心表（`_linchkit_messages`）中，而非每个 Schema 一张表。这保持数据模型简洁，支持跨 Schema 搜索，避免新增 Schema 时的 DDL 变更。

## 3. Core 前置条件：EventBus 增强

### 3.1 `record.updated` 事件需携带字段 diff

**现状问题：** `record.updated` 事件当前不携带字段 diff 数据。`ExecutionLogEntry` 有 `changes[]`（包含 `before`/`after`/`changedFields`），但这些数据不流入 EventBus 事件的 payload。

**需要的 Core 变更：**

```typescript
// EventBus record.updated event payload — 增强后
interface RecordUpdatedEventPayload {
  schema: string;
  recordId: string;
  // 新增字段 diff 数据
  changedFields: string[];        // 实际变更的字段名列表
  before: Record<string, unknown>; // 变更前的值（仅变更字段）
  after: Record<string, unknown>;  // 变更后的值（仅变更字段）
}
```

这是 Chatter 字段级变更审计的前提。此变更属于 Core，应在 M2 或 M3 初期完成。

### 3.2 `formPanels` 扩展类型

`CapabilityExtensions` 需要新增 `formPanels` 扩展类型，允许 Capability 向表单页面注入 UI 面板：

```typescript
interface CapabilityExtensions {
  // ... existing extensions ...
  formPanels?: FormPanelExtension[];
}

interface FormPanelExtension {
  name: string;
  label: string;
  position: "below" | "side" | "tab";
  component: string;               // Component name registered in UI
  props?: (context: FormContext) => Record<string, unknown>;
}
```

## 4. 数据模型

### 4.1 Messages 表

```sql
-- In _linchkit PostgreSQL schema (same as other system tables)
CREATE TABLE _linchkit.messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     VARCHAR(255),

  -- Polymorphic record reference
  schema_name   VARCHAR(255) NOT NULL,
  record_id     VARCHAR(255) NOT NULL,

  -- Message classification
  message_type  VARCHAR(50) NOT NULL,
  -- 'comment'  = user-visible discussion
  -- 'note'     = internal note (team-only, not visible to external parties)
  -- 'log'      = auto-generated system log entry
  -- 'ai'       = AI conversation / insight (requires cap-ai)

  -- Content
  body          TEXT NOT NULL,           -- Markdown (rendered as rich text in UI)
  body_html     TEXT,                    -- Pre-rendered HTML (optional, for email)

  -- Author
  author_id     VARCHAR(255) NOT NULL,
  author_type   VARCHAR(50) NOT NULL DEFAULT 'user',  -- 'user' | 'system' | 'ai'
  author_name   VARCHAR(255),           -- Denormalized for display

  -- Threading
  parent_id     UUID REFERENCES _linchkit.messages(id),  -- NULL = top-level
  thread_count  INTEGER NOT NULL DEFAULT 0,              -- Denormalized reply count

  -- Mentions (extracted from body, stored for indexed queries)
  mentions      JSONB NOT NULL DEFAULT '[]',
  -- e.g. [{ "type": "user", "id": "u_001", "name": "Alice" }]

  -- Attachments (references to _linchkit.attachments)
  attachment_ids JSONB NOT NULL DEFAULT '[]',
  -- e.g. ["att_001", "att_002"]

  -- Log-specific metadata (only for message_type = 'log')
  log_event     VARCHAR(255),           -- e.g. 'state.transition', 'record.updated'
  log_metadata  JSONB,                  -- Structured data for the log entry
  -- e.g. { "from": "draft", "to": "submitted", "action": "submit_request" }
  -- e.g. { "changed_fields": ["amount", "vendor"], "before": {...}, "after": {...} }

  -- Reactions (lightweight inline storage)
  reactions     JSONB NOT NULL DEFAULT '{}',
  -- e.g. { "thumbsup": ["u_001", "u_002"], "tada": ["u_003"] }

  -- Soft delete
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at    TIMESTAMP,
  deleted_by    VARCHAR(255),

  -- Timestamps
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Indexes
  -- (schema_name, record_id, created_at DESC) — primary query path
  -- (author_id) — "my messages" queries
  -- (parent_id) — thread loading
  -- GIN index on mentions — @mention queries
);
```

Drizzle 定义：

```typescript
import { linchkitSchema } from "@linchkit/core/persistence/system-tables";

export const messagesTable = linchkitSchema.table(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 255 }),
    schemaName: varchar("schema_name", { length: 255 }).notNull(),
    recordId: varchar("record_id", { length: 255 }).notNull(),
    messageType: varchar("message_type", { length: 50 }).notNull(),
    body: text("body").notNull(),
    bodyHtml: text("body_html"),
    authorId: varchar("author_id", { length: 255 }).notNull(),
    authorType: varchar("author_type", { length: 50 }).notNull().default("user"),
    authorName: varchar("author_name", { length: 255 }),
    parentId: uuid("parent_id"),
    threadCount: integer("thread_count").notNull().default(0),
    mentions: jsonb("mentions").notNull().default([]),
    attachmentIds: jsonb("attachment_ids").notNull().default([]),
    logEvent: varchar("log_event", { length: 255 }),
    logMetadata: jsonb("log_metadata"),
    reactions: jsonb("reactions").notNull().default({}),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at"),
    deletedBy: varchar("deleted_by", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    recordIdx: index("messages_record_idx").on(
      table.schemaName, table.recordId, table.createdAt,
    ),
    authorIdx: index("messages_author_idx").on(table.authorId),
    parentIdx: index("messages_parent_idx").on(table.parentId),
  }),
);
```

### 4.2 Followers 表

关注者定义谁会收到记录活动的通知。

```sql
CREATE TABLE _linchkit.followers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   VARCHAR(255),

  schema_name VARCHAR(255) NOT NULL,
  record_id   VARCHAR(255) NOT NULL,

  user_id     VARCHAR(255) NOT NULL,
  user_name   VARCHAR(255),             -- Denormalized

  -- What to follow
  follow_type VARCHAR(50) NOT NULL DEFAULT 'all',
  -- 'all'       = all activity
  -- 'comments'  = only user comments (not log entries)
  -- 'state'     = only state transitions

  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),

  UNIQUE (schema_name, record_id, user_id)
);
```

### 4.3 Attachments 表

文件附件，支持可插拔的存储后端。

```sql
CREATE TABLE _linchkit.attachments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     VARCHAR(255),

  file_name     VARCHAR(1024) NOT NULL,
  mime_type     VARCHAR(255) NOT NULL,
  file_size     BIGINT NOT NULL,          -- Bytes

  -- Storage
  storage_backend VARCHAR(50) NOT NULL DEFAULT 'local',
  -- 'local' = filesystem  |  's3' = S3-compatible  |  'database' = pg bytea (dev only)
  storage_path  VARCHAR(4096) NOT NULL,   -- Local path or S3 key

  -- Metadata
  checksum      VARCHAR(128),             -- SHA-256
  metadata      JSONB NOT NULL DEFAULT '{}',
  -- e.g. { "width": 800, "height": 600 } for images

  uploaded_by   VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Soft delete
  is_deleted    BOOLEAN NOT NULL DEFAULT FALSE,
  deleted_at    TIMESTAMP
);
```

### 4.4 消息类型详解

| 类型 | 生成方式 | 可见范围 | 示例 |
|------|---------|---------|------|
| `comment` | 用户手动 | 所有记录查看者 | "能否和这个供应商谈更好的价格？" |
| `note` | 用户手动 | 仅内部团队（尊重权限组） | "财务标记了这个金额 — 检查预算" |
| `log` | 系统自动 | 所有记录查看者 | "状态变更：草稿 -> 已提交（by Alice）" |
| `ai` | AI 系统 | 取决于配置 | "基于历史数据分析，该供应商的平均交付时间为 7 天" |

Log 条目由 EventHandler 自动生成，监听框架运行时事件（`record.created`、`record.updated`、`state.transition`、`action.succeeded`）并写入消息记录。

## 5. 自动记录（Auto-Logging）via EventHandler

Capability 注册 EventHandler，监听运行时事件并自动创建 `log` 类型消息。

### 5.1 字段变更审计规则

**关键设计决策：** 不同事件类型的记录策略不同，以避免噪音：

| 事件 | 记录策略 | 理由 |
|------|---------|------|
| `record.created` | 仅记录 "Created this record"，**不记录各字段值** | 创建时所有字段都是"新的"，逐一列出只是噪音 |
| `record.updated` | 仅记录**实际变更**的字段（比较 before/after） | 精确审计，排除无意义的变更 |
| `state.transition` | 记录 "Status: Draft -> Approved" | 状态迁移是独立事件，单独记录 |
| `record.deleted` | 记录 "Deleted this record" | 简洁明了 |

**`record.updated` 排除的系统字段：**

以下字段即使发生变更也**不记录**在 log 中（避免噪音）：
- `updated_at`
- `_version`
- `created_at`
- `created_by`
- `updated_by`
- `is_deleted`

### 5.2 EventHandler 实现

```typescript
// System fields excluded from change audit
const EXCLUDED_SYSTEM_FIELDS = new Set([
  "updated_at", "_version", "created_at",
  "created_by", "updated_by", "is_deleted",
]);

export const chatterAutoLog = defineEventHandler({
  name: "chatter.auto_log",
  label: "Chatter Auto-Log",
  description: "Generates log entries in chatter when records change",

  listen: [
    "record.created",
    "record.updated",
    "record.deleted",
    "state.transition",
  ],

  async handler(event, ctx) {
    const logMessages: Record<string, () => LogEntry | null> = {
      "record.created": () => ({
        body: "Created this record.",
        logEvent: "record.created",
        logMetadata: {},
      }),

      "record.updated": () => {
        // Filter out system fields from changed fields
        const changedFields = (event.payload.changedFields ?? [])
          .filter((f: string) => !EXCLUDED_SYSTEM_FIELDS.has(f));

        // Nothing meaningful changed — skip log entry entirely
        if (changedFields.length === 0) return null;

        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const field of changedFields) {
          before[field] = event.payload.before?.[field];
          after[field] = event.payload.after?.[field];
        }

        return {
          body: formatChangedFields(changedFields, before, after),
          logEvent: "record.updated",
          logMetadata: {
            changed_fields: changedFields,
            before,
            after,
          },
        };
      },

      "state.transition": () => ({
        body: `Status: **${event.payload.from}** → **${event.payload.to}**`,
        logEvent: "state.transition",
        logMetadata: {
          from: event.payload.from,
          to: event.payload.to,
          action: event.payload.action,
        },
      }),

      "record.deleted": () => ({
        body: "Deleted this record.",
        logEvent: "record.deleted",
        logMetadata: {},
      }),
    };

    const entry = logMessages[event.type]?.();
    if (!entry || !event.schema || !event.recordId) return;

    await ctx.services.chatter.createMessage({
      schemaName: event.schema,
      recordId: event.recordId,
      messageType: "log",
      body: entry.body,
      authorId: event.actor.id,
      authorType: event.actor.type,
      logEvent: entry.logEvent,
      logMetadata: entry.logMetadata,
      tenantId: event.tenantId,
    });
  },
});
```

### 5.3 `formatChangedFields` 实现

```typescript
function formatChangedFields(
  changedFields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const lines = changedFields.map((field) => {
    const oldVal = before[field] ?? "(empty)";
    const newVal = after[field] ?? "(empty)";
    return `- **${field}**: ${oldVal} → ${newVal}`;
  });
  return `Updated ${changedFields.length} field(s):\n${lines.join("\n")}`;
}
```

## 6. 文件附件

### 6.1 存储后端

```typescript
interface AttachmentStorageBackend {
  name: string;
  upload(file: File, metadata: UploadMetadata): Promise<StorageResult>;
  download(storagePath: string): Promise<ReadableStream>;
  delete(storagePath: string): Promise<void>;
  getUrl(storagePath: string, options?: { expiresIn?: number }): Promise<string>;
}
```

内置后端：

| Backend | Config Key | 说明 |
|---------|-----------|------|
| `local` | `chatter.storage.local.basePath` | 默认。文件存储在 `data/attachments/`。开发友好。 |
| `s3` | `chatter.storage.s3.*` | S3 兼容（AWS、MinIO、Cloudflare R2）。生产就绪。 |

配置方式（`linchkit.config.ts`）：

```typescript
export default defineConfig({
  capabilities: [capChatter],
  chatter: {
    storage: {
      backend: "local",  // or "s3"
      local: {
        basePath: "./data/attachments",
      },
      s3: {
        bucket: "linchkit-attachments",
        region: "us-east-1",
        endpoint: "https://s3.amazonaws.com",
        // credentials from env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
      },
    },
    maxFileSize: 10 * 1024 * 1024,  // 10 MB default
    allowedMimeTypes: ["*/*"],       // Restrict if needed
  },
});
```

### 6.2 Upload REST Endpoint

```
POST /api/attachments/upload
Content-Type: multipart/form-data
Authorization: Bearer <token>

Form fields:
  file: <binary>

Response:
{
  "id": "att_uuid",
  "fileName": "invoice.pdf",
  "mimeType": "application/pdf",
  "fileSize": 204800,
  "url": "/api/attachments/att_uuid/download"
}
```

Download:

```
GET /api/attachments/:id/download
Authorization: Bearer <token>

→ 200 with file stream (Content-Disposition: attachment)
```

附件先上传获得 ID，然后在创建消息时引用。这解耦了上传和消息创建，支持拖拽 UX。

## 7. 通知

### 7.1 关注者模型

用户可以关注记录以接收通知。关注发生在：

- **自动关注**：记录创建者自动关注。被分配到记录的用户（如 `assigned_to` 字段）自动关注。
- **手动关注**：用户在记录上点击"关注"按钮。用户在评论中被 @提及。
- **程序化关注**：Action 可通过 `ctx.services.chatter.addFollower()` 添加关注者。

### 7.2 通知触发条件

| 触发条件 | 接收者 | 条件 |
|---------|-------|------|
| 新评论 | 所有 `follow_type` = `all` 或 `comments` 的关注者 | 总是 |
| 新备注 | 与作者同权限组的关注者 | 备注是内部的 |
| 状态变更 | `follow_type` = `all` 或 `state` 的关注者 | 总是 |
| @提及 | 被提及的用户（如未关注则自动关注） | 总是 |

### 7.3 通知投递

Phase 1 (M3)：仅 in-app 通知。

```typescript
interface ChatterNotification {
  id: string;
  recipientId: string;
  type: "new_message" | "mention" | "state_change";
  schemaName: string;
  recordId: string;
  messageId: string;
  preview: string;       // First 100 chars of body
  isRead: boolean;
  createdAt: Date;
}
```

投递方式：
- **SSE subscription**（复用现有 `onNewMessage` GraphQL subscription，来自 spec 44）
- **Notification bell** — UI header 中的未读计数 badge

Phase 2（future）：Email 通知、Webhook 投递、Slack/Teams 集成 — 各作为独立 Capability 或扩展。

### 7.4 @提及解析

消息 body 中的提及使用 `@[Display Name](user:user_id)` 语法（类似 Markdown link）。解析器：

1. 从 body 文本中提取提及引用
2. 对 auth provider 解析用户 ID
3. 将解析后的提及存储在 `mentions` JSONB 列中
4. 为每个被提及的用户触发通知
5. 自动关注被提及用户在该记录上

## 8. GraphQL API

### 8.1 Types

```graphql
enum MessageType {
  comment
  note
  log
  ai
}

type ChatterMessage {
  id: ID!
  schemaName: String!
  recordId: String!
  messageType: MessageType!
  body: String!
  bodyHtml: String

  author: MessageAuthor!
  parent: ChatterMessage
  replies: [ChatterMessage!]!
  replyCount: Int!

  mentions: [Mention!]!
  attachments: [Attachment!]!
  reactions: JSON

  logEvent: String
  logMetadata: JSON

  createdAt: DateTime!
  updatedAt: DateTime!
}

type MessageAuthor {
  id: String!
  type: String!    # user | system | ai
  name: String
}

type Mention {
  type: String!    # user
  id: String!
  name: String
}

type Attachment {
  id: ID!
  fileName: String!
  mimeType: String!
  fileSize: Int!
  url: String!
  uploadedBy: String!
  createdAt: DateTime!
}

type Follower {
  id: ID!
  userId: String!
  userName: String
  followType: String!
  createdAt: DateTime!
}

type ChatterMessageConnection {
  items: [ChatterMessage!]!
  totalCount: Int!
  hasMore: Boolean!
}
```

### 8.2 Queries

```graphql
type Query {
  # Paginated message list for a record (top-level messages only)
  chatterMessages(
    schemaName: String!
    recordId: String!
    messageType: MessageType           # Filter by type
    limit: Int = 20
    offset: Int = 0
  ): ChatterMessageConnection!

  # Thread replies for a specific message
  chatterThread(messageId: ID!): [ChatterMessage!]!

  # Followers for a record
  chatterFollowers(
    schemaName: String!
    recordId: String!
  ): [Follower!]!

  # Unread notification count for current user
  chatterUnreadCount: Int!

  # Recent notifications for current user
  chatterNotifications(
    limit: Int = 20
    offset: Int = 0
  ): [ChatterNotification!]!
}
```

### 8.3 Mutations

```graphql
type Mutation {
  # Post a comment or note
  chatterAddMessage(
    schemaName: String!
    recordId: String!
    messageType: MessageType!  # comment | note (log/ai are system-only)
    body: String!
    parentId: ID               # For threaded replies
    attachmentIds: [ID!]       # Previously uploaded attachment IDs
  ): ChatterMessage!

  # Edit a message (author only, within time window)
  chatterEditMessage(
    messageId: ID!
    body: String!
  ): ChatterMessage!

  # Delete a message (soft delete, author or admin)
  chatterDeleteMessage(messageId: ID!): Boolean!

  # Toggle reaction
  chatterToggleReaction(
    messageId: ID!
    emoji: String!
  ): ChatterMessage!

  # Follow / unfollow a record
  chatterFollow(
    schemaName: String!
    recordId: String!
    followType: String = "all"
  ): Follower!

  chatterUnfollow(
    schemaName: String!
    recordId: String!
  ): Boolean!

  # Mark notifications as read
  chatterMarkRead(notificationIds: [ID!]!): Boolean!
  chatterMarkAllRead: Boolean!
}
```

### 8.4 Subscriptions

```graphql
type Subscription {
  # Real-time new messages on a record
  onChatterMessage(
    schemaName: String!
    recordId: String!
  ): ChatterMessage!

  # Notifications for current user
  onChatterNotification: ChatterNotification!
}
```

通过 SSE 实现（与 spec 44 一致），复用 `cap-adapter-server` 中现有的 subscription 基础设施。

## 9. Chatter Service

Capability 通过 `extensions.services` 注册 `chatter` 服务，使其可通过 `ctx.services.chatter` 供其他 Capability 使用。

```typescript
interface ChatterService {
  // Messages
  createMessage(input: CreateMessageInput): Promise<ChatterMessage>;
  editMessage(messageId: string, body: string, actorId: string): Promise<ChatterMessage>;
  deleteMessage(messageId: string, actorId: string): Promise<void>;
  getMessages(schemaName: string, recordId: string, options?: MessageQueryOptions): Promise<PaginatedMessages>;
  getThread(messageId: string): Promise<ChatterMessage[]>;

  // Reactions
  toggleReaction(messageId: string, emoji: string, userId: string): Promise<void>;

  // Followers
  addFollower(schemaName: string, recordId: string, userId: string, followType?: string): Promise<void>;
  removeFollower(schemaName: string, recordId: string, userId: string): Promise<void>;
  getFollowers(schemaName: string, recordId: string): Promise<Follower[]>;
  isFollowing(schemaName: string, recordId: string, userId: string): Promise<boolean>;

  // Notifications
  notify(recipients: string[], notification: NotificationInput): Promise<void>;
  getUnreadCount(userId: string): Promise<number>;
  markRead(userId: string, notificationIds: string[]): Promise<void>;

  // Attachments
  uploadAttachment(file: File, uploadedBy: string, tenantId?: string): Promise<Attachment>;
  getAttachment(id: string): Promise<Attachment>;
  deleteAttachment(id: string): Promise<void>;
}
```

## 10. UI 组件

所有 UI 组件位于 `cap-chatter` 中，通过 `extensions.formPanels` 注入表单布局。

### 10.1 ChatterPanel — 统一时间线视图

主组件，在记录详情/编辑页面渲染。**替代现有 ActivityPanel**。

```
┌─────────────────────────────────────────┐
│ Record Form                             │
│ ┌─────────────────────────────────────┐ │
│ │ Field 1: [value]                    │ │
│ │ Field 2: [value]                    │ │
│ │ ...                                 │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ Timeline ──────────────────────────┤
│ │ [All] [Comments] [Notes] [Log] [AI] │  ← Tab filter
│ │                                     │
│ │ ┌─ Composer ──────────────────────┐ │
│ │ │ Write a comment...      [Send]  │ │  ← Rich text + attach + @mention
│ │ └─────────────────────────────────┘ │
│ │                                     │
│ │ ┌─ Comment ───────────────────────┐ │
│ │ │ Alice · 2 hours ago             │ │
│ │ │ Can we check pricing with @Bob? │ │
│ │ │ [file] quote.pdf (204 KB)       │ │
│ │ │ [+1 2] [Reply] [...]            │ │
│ │ │                                 │ │
│ │ │ ┌─ Reply ───────────────────┐   │ │
│ │ │ │ Bob · 1 hour ago          │   │ │
│ │ │ │ Confirmed, pricing valid. │   │ │
│ │ │ └───────────────────────────┘   │ │
│ │ └─────────────────────────────────┘ │
│ │                                     │
│ │ ┌─ Log: Field Change ─────────────┐ │
│ │ │ [edit] Updated 2 field(s):      │ │
│ │ │   - amount: 5000 → 8000         │ │
│ │ │   - vendor: Acme → GlobalCo     │ │
│ │ │   Alice · 3 hours ago           │ │
│ │ └─────────────────────────────────┘ │
│ │                                     │
│ │ ┌─ Log: State Transition ─────────┐ │
│ │ │ [arrow] Status: Draft → Submit  │ │
│ │ │   Alice · 4 hours ago           │ │
│ │ └─────────────────────────────────┘ │
│ │                                     │
│ │ ┌─ Log: Created ──────────────────┐ │
│ │ │ [plus] Created this record      │ │
│ │ │   Alice · 5 hours ago           │ │
│ │ └─────────────────────────────────┘ │
│ │                                     │
│ │ [Load more...]                      │
│ └─────────────────────────────────────┘
└─────────────────────────────────────────┘
```

### 10.2 组件拆分

| 组件 | 用途 |
|------|------|
| `ChatterPanel` | 容器：tabs、消息列表、composer。接收 `schemaName` + `recordId` props。**替代 ActivityPanel**。 |
| `MessageComposer` | 富文本输入（Markdown）、文件拖拽、@提及自动完成、发送按钮。 |
| `MessageItem` | 单条消息显示：头像、作者、时间戳、body（渲染 Markdown）、附件、reactions、回复按钮。 |
| `ThreadView` | 父消息下的缩进回复列表。 |
| `LogEntry` | 紧凑的系统日志条目显示：图标 + 变更详情 + 时间戳。支持字段 diff 展开。 |
| `FollowerBar` | "关注"开关 + 关注者头像列表。显示在 chatter 面板上方。 |
| `NotificationBell` | Header 图标，带未读计数 badge。下拉显示最近通知。 |
| `AttachmentPreview` | 图片内联预览，其他文件类型显示下载链接。 |

### 10.3 与 AutoForm 集成

`ChatterPanel` 通过 `formPanels` 扩展注入表单页面布局：

```typescript
extensions: {
  formPanels: [
    {
      name: "chatter",
      label: "Timeline",
      position: "below",     // below the form fields
      component: "ChatterPanel",
      // Props derived from route params
      props: (context) => ({
        schemaName: context.schemaName,
        recordId: context.recordId,
      }),
    },
  ],
}
```

`cap-adapter-ui` 读取所有已安装 Capability 的 `formPanels` 扩展，在表单页面的适当位置渲染。不需要修改 core 表单布局逻辑。

### 10.4 @提及自动完成

Composer 使用 mention 插件：

1. 在文本输入中输入 `@` 时触发
2. 查询用户搜索端点（由 `cap-auth` 或用户目录服务提供）
3. 显示匹配用户的下拉列表
4. 在 Markdown body 中插入 `@[Display Name](user:user_id)`
5. 提交时将用户添加到 `mentions` 数组

## 11. Capability 结构

```
capabilities/
  cap-chatter/
    capability.ts              # defineCapability — registers everything
    src/
      tables/
        messages.ts            # Drizzle table definition
        followers.ts
        attachments.ts
        notifications.ts
      service/
        chatter-service.ts     # ChatterService implementation
        notification-service.ts
        attachment-storage.ts  # StorageBackend interface + implementations
      graphql/
        types.ts               # GraphQL type definitions
        resolvers.ts           # Query, Mutation, Subscription resolvers
      handlers/
        auto-log.ts            # EventHandler for auto-logging (field diff audit)
        auto-follow.ts         # EventHandler for auto-following creators
        mention-notify.ts      # EventHandler for @mention notifications
      rest/
        attachment-routes.ts   # Upload/download REST endpoints
    ui/
      components/
        chatter-panel.tsx      # Unified timeline (replaces ActivityPanel)
        message-composer.tsx
        message-item.tsx
        thread-view.tsx
        log-entry.tsx          # Field diff display, state transition display
        follower-bar.tsx
        notification-bell.tsx
        attachment-preview.tsx
      hooks/
        use-chatter.ts         # Data fetching + subscription hook
        use-notifications.ts   # Notification state hook
    package.json
    tsconfig.json
```

### 11.1 Capability 定义

```typescript
import { defineCapability } from "@linchkit/core";

export default defineCapability({
  name: "chatter",
  label: "Chatter — Unified Record Timeline",
  description: "Record-level unified timeline: field audit, execution log, comments, AI insights, state transitions",
  type: "standard",
  category: "system",
  version: "0.1.0",

  dependencies: [],   // Works without cap-auth (uses anonymous actor)
  optionalDependencies: ["cap-auth", "cap-ai"],

  eventHandlers: [chatterAutoLog, autoFollowCreator, mentionNotify],

  extensions: {
    services: [
      {
        name: "chatter",
        factory: (ctx) => new ChatterServiceImpl(ctx),
      },
    ],
    systemTables: [messagesTable, followersTable, attachmentsTable, notificationsTable],
    formPanels: [
      {
        name: "chatter",
        label: "Timeline",
        position: "below",
        component: "ChatterPanel",
      },
    ],
  },
});
```

## 12. 权限

当 `cap-permission` 安装时，Chatter 遵守以下权限规则：

| 操作 | 默认权限 | 说明 |
|------|---------|------|
| 查看评论 | Schema 的 Read 权限 | 能看记录就能看评论 |
| 发布评论 | Schema 的 Read 权限 | 查看者可评论 |
| 发布备注 | Schema 的 Write 权限 | 备注是内部的 |
| 编辑消息 | 仅自己的消息，15 分钟内 | 可配置时间窗口 |
| 删除消息 | 自己的消息，或 admin 角色 | Admin 可删除任何消息 |
| 关注/取消关注 | Schema 的 Read 权限 | 有访问权限者可关注 |
| 上传附件 | Schema 的 Read 权限 | 文件大小限制适用 |
| 查看日志条目 | Schema 的 Read 权限 | 日志始终可见 |

当 `cap-permission` 未安装时，所有操作均允许（开放模式，与 LinchKit 其余部分一致）。

## 13. 配置

```typescript
// In linchkit.config.ts
{
  chatter: {
    // Storage
    storage: {
      backend: "local" | "s3",
      local: { basePath: string },
      s3: { bucket: string, region: string, endpoint?: string },
    },

    // Limits
    maxFileSize: number,            // Default: 10 MB
    allowedMimeTypes: string[],     // Default: ["*/*"]
    maxMessageLength: number,       // Default: 10000 chars
    editWindowMinutes: number,      // Default: 15

    // Auto-logging
    autoLog: {
      enabled: boolean,             // Default: true
      events: string[],             // Default: all runtime events
      // System fields always excluded: updated_at, _version, created_at, created_by, updated_by, is_deleted
      excludeFields: string[],      // Additional fields to omit from change logs
    },

    // Auto-follow
    autoFollow: {
      creator: boolean,             // Default: true
      assignee: boolean,            // Default: true
      assigneeField: string,        // Default: "assigned_to"
    },

    // UI
    ui: {
      defaultTab: "all" | "comments" | "notes" | "log" | "ai",  // Default: "all"
      showFollowerBar: boolean,     // Default: true
      enableReactions: boolean,     // Default: true
      enableThreading: boolean,     // Default: true
    },
  },
}
```

## 14. MCP 集成

当 `cap-adapter-mcp` 安装时，Chatter 暴露额外的 MCP tools：

| Tool | 描述 |
|------|------|
| `list_messages` | 列出指定 schema + record 的消息（支持类型过滤） |
| `add_comment` | 在记录上发布评论 |
| `add_note` | 在记录上发布内部备注 |
| `get_activity_log` | 获取记录的自动生成活动日志（字段变更、状态流转等） |
| `follow_record` | 关注记录以接收通知 |

这使 AI agent 能够参与记录讨论、发布分析结果作为备注、监控记录活动。

## 15. 性能考量

- **分页**：所有消息查询分页（默认 20，最大 100）。无无界查询。
- **反规范化**：`author_name`、`thread_count` 反规范化以避免热路径上的 join。
- **DataLoader**：GraphQL resolver 使用 DataLoader 批量加载附件和作者（与 Link resolver 模式一致）。
- **附件流式传输**：文件下载直接从存储后端流式传输，不缓冲到内存。
- **索引策略**：主索引 `(schema_name, record_id, created_at DESC)` 覆盖主查询路径。GIN 索引在 `mentions` 上用于 @提及查询。
- **软删除过滤**：查询默认 `is_deleted = false`。显式标志可包含已删除消息（admin 用途）。

## 16. 迁移与回滚

- 安装 `cap-chatter` 运行 `drizzle-kit generate` + `migrate` 在 `_linchkit` schema 中创建系统表。
- 卸载**不**删除表（数据保留）。表变为惰性。
- 重新安装无缝恢复现有数据。

## 17. 未来扩展（M3 范围外）

| 功能 | 描述 | 里程碑 |
|------|------|--------|
| Email 通知 | 向关注者发送新消息邮件 | M4 |
| Webhook 投递 | POST 通知 payload 到外部 URL | M4 |
| Slack/Teams 集成 | 转发消息到频道 | M4+（独立 Capability） |
| 富文本编辑器 | WYSIWYG 替代 Markdown（如 Tiptap） | M4 |
| 消息搜索 | 跨所有消息的全文搜索 | M4 |
| 置顶消息 | 将重要消息固定到 feed 顶部 | M4 |
| AI 摘要 | AI 生成的讨论线程摘要 | M4+（依赖 `cap-ai`） |
| 已读回执 | 追踪谁阅读了哪些消息 | M4+ |
| 可观测性集成 | 将 traces/metrics 嵌入时间线 | M4+（依赖 Spec 28） |
