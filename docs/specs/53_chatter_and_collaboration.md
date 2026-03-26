# Chatter & Collaboration

> This spec extends [Spec 14 — System Capabilities](./14_system_capabilities.md) §4.7. Read that spec first for context.
>
> Spec 14 lists `@linchkit/cap-comment` as a "suggested install" system capability providing comment/activity features (Schema: `comment`, `activity`; Action: `add_comment`, `add_reply`; auto activity log). This spec provides the **detailed design** for that capability, renamed to `@linchkit/cap-chatter` to better reflect its broader scope (messaging + activity log + followers + attachments + notifications), superseding the brief outline in spec 14 §4.7.

> Status: Draft | Date: 2026-03-26
> Milestone: M3 (post-M2)
> Capability: `@linchkit/cap-chatter` (supersedes `@linchkit/cap-comment` from spec 14)

## 1. Problem

Business applications need contextual collaboration on records. Users need to:

- Discuss a purchase request directly on its form page
- See an audit trail of what changed, when, and by whom
- @mention colleagues to draw attention
- Attach files to discussions
- Get notified when records they follow are updated

Without this, collaboration happens in external tools (email, Slack) and context is lost. The audit trail becomes invisible.

## 2. Design Principles

### 2.1 Capability, Not Core

Chatter is a capability (`@linchkit/cap-chatter`), NOT part of `@linchkit/core`. Core remains minimal. The capability registers system tables, GraphQL types, and UI components via `extensions`.

This follows the architecture from [Spec 14](./14_system_capabilities.md) §2 — system functionality is delivered as official Capability packages, not framework-hardcoded features. Chatter integrates with other system capabilities via weak dependencies (see spec 14 §5):
- `cap-auth` — user resolution for @mentions and author display (optional; works with anonymous actor)
- `cap-notification` — notification delivery (optional; in-app notifications built-in, cap-notification adds channels)
- `cap-file-storage` — attachment storage backend (optional; chatter includes its own attachment storage)

Rationale: Not every deployment needs collaboration (e.g., headless API, pure MCP agent). Installing `cap-chatter` opts in; uninstalling removes it cleanly.

### 2.2 Inspiration

| System | Key Ideas Borrowed |
|--------|-------------------|
| **Odoo Chatter** | Unified message feed on every record; log notes vs. comments; follower model; auto-log on state change |
| **Salesforce Chatter** | Feed items with typed payloads; @mentions resolve to users; rich text body |
| **GitHub Issues/PRs** | Timeline model (comments + events interleaved); reactions; threaded replies |

### 2.3 Single Table, All Schemas

Messages are stored in one central table (`_linchkit_messages`), not per-schema tables. This keeps the data model simple, enables cross-schema search, and avoids DDL changes when new schemas are added.

## 3. Data Model

### 3.1 Messages Table

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
  -- e.g. { "👍": ["u_001", "u_002"], "🎉": ["u_003"] }

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

Drizzle definition:

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

### 3.2 Followers Table

Followers define who gets notified about activity on a record.

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

### 3.3 Attachments Table

File attachments with pluggable storage backend.

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
  deleted_at    TIMESTAMP,
);
```

### 3.4 Message Types in Detail

| Type | Generated By | Visible To | Example |
|------|-------------|------------|---------|
| `comment` | User manually | All record viewers | "Can we negotiate better pricing with this vendor?" |
| `note` | User manually | Internal team only (respects permission groups) | "Finance flagged this amount — check budget" |
| `log` | System auto | All record viewers | "State changed: draft → submitted by Alice" |

Log entries are auto-generated by an EventHandler that listens to framework runtime events (`record.created`, `record.updated`, `state.transition`, `action.succeeded`) and writes message records.

## 4. Auto-Logging via EventHandler

The capability registers EventHandlers that listen to runtime events and create `log` type messages automatically.

```typescript
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
    const logMessages: Record<string, () => LogEntry> = {
      "record.created": () => ({
        body: `Created this record.`,
        logEvent: "record.created",
        logMetadata: { fields: Object.keys(event.payload.data ?? {}) },
      }),
      "record.updated": () => ({
        body: formatChangedFields(event.payload.changedFields, event.payload.before, event.payload.after),
        logEvent: "record.updated",
        logMetadata: {
          changed_fields: event.payload.changedFields,
          before: event.payload.before,
          after: event.payload.after,
        },
      }),
      "state.transition": () => ({
        body: `State changed: **${event.payload.from}** → **${event.payload.to}** (via ${event.payload.action})`,
        logEvent: "state.transition",
        logMetadata: {
          from: event.payload.from,
          to: event.payload.to,
          action: event.payload.action,
        },
      }),
      "record.deleted": () => ({
        body: `Deleted this record.`,
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

## 5. File Attachments

### 5.1 Storage Backends

```typescript
interface AttachmentStorageBackend {
  name: string;
  upload(file: File, metadata: UploadMetadata): Promise<StorageResult>;
  download(storagePath: string): Promise<ReadableStream>;
  delete(storagePath: string): Promise<void>;
  getUrl(storagePath: string, options?: { expiresIn?: number }): Promise<string>;
}
```

Built-in backends:

| Backend | Config Key | Notes |
|---------|-----------|-------|
| `local` | `chatter.storage.local.basePath` | Default. Files stored in `data/attachments/`. Dev-friendly. |
| `s3` | `chatter.storage.s3.*` | S3-compatible (AWS, MinIO, Cloudflare R2). Production-ready. |

Configuration via `linchkit.config.ts`:

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

### 5.2 Upload REST Endpoint

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

Attachments are uploaded first, then referenced by ID when creating a message. This decouples upload from message creation and allows drag-and-drop UX.

## 6. Notifications

### 6.1 Follower Model

Users can follow a record to receive notifications. Following happens:

- **Automatically**: Record creator is auto-followed. Users assigned to the record (e.g., `assigned_to` field) are auto-followed.
- **Manually**: User clicks "Follow" button on the record. User is @mentioned in a comment.
- **Programmatically**: Actions can add followers via `ctx.services.chatter.addFollower()`.

### 6.2 Notification Triggers

| Trigger | Recipients | Condition |
|---------|-----------|-----------|
| New comment | All followers with `follow_type` = `all` or `comments` | Always |
| New note | Followers who are in the same permission groups as the author | Notes are internal |
| State change | Followers with `follow_type` = `all` or `state` | Always |
| @mention | Mentioned user (auto-followed if not already) | Always |

### 6.3 Notification Delivery

Phase 1 (M3): In-app notifications only.

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

Delivered via:
- **SSE subscription** (reuses existing `onNewMessage` GraphQL subscription from spec 44)
- **Notification bell** in UI header (unread count badge)

Phase 2 (future): Email notifications, webhook delivery, Slack/Teams integration — each as a separate capability or extension.

### 6.4 @Mention Resolution

Mentions in message body use `@[Display Name](user:user_id)` syntax (Markdown link-like). The parser:

1. Extracts mention references from body text
2. Resolves user IDs against the auth provider
3. Stores resolved mentions in the `mentions` JSONB column
4. Triggers notification for each mentioned user
5. Auto-follows mentioned users on the record

## 7. GraphQL API

### 7.1 Types

```graphql
enum MessageType {
  comment
  note
  log
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

### 7.2 Queries

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

### 7.3 Mutations

```graphql
type Mutation {
  # Post a comment or note
  chatterAddMessage(
    schemaName: String!
    recordId: String!
    messageType: MessageType!  # comment | note (log is system-only)
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

### 7.4 Subscriptions

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

Implemented via SSE (consistent with spec 44), piggybacking on the existing subscription infrastructure in `cap-adapter-server`.

## 8. Chatter Service

The capability registers a `chatter` service via `extensions.services`, making it available to other capabilities via `ctx.services.chatter`.

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

## 9. UI Components

All UI components live in `cap-chatter` and are registered via `extensions.viewTypes` or injected into the form layout via a panel slot.

### 9.1 ChatterPanel

The primary component, rendered on record detail/edit pages.

```
┌─────────────────────────────────────────┐
│ Record Form                             │
│ ┌─────────────────────────────────────┐ │
│ │ Field 1: [value]                    │ │
│ │ Field 2: [value]                    │ │
│ │ ...                                 │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ Chatter ─────────────────────────────┤
│ │ [Comment] [Note] [Activity Log]       │  ← Tab filter
│ │                                       │
│ │ ┌─ Composer ────────────────────────┐ │
│ │ │ Write a comment...        [Send]  │ │  ← Rich text + attach button
│ │ └───────────────────────────────────┘ │
│ │                                       │
│ │ ┌─ Message ─────────────────────────┐ │
│ │ │ 👤 Alice · 2 hours ago            │ │
│ │ │ Can we check pricing with @Bob?   │ │
│ │ │ 📎 quote.pdf (204 KB)             │ │
│ │ │ [👍 2] [Reply] [···]              │ │
│ │ │                                   │ │
│ │ │ ┌─ Reply ─────────────────────┐   │ │
│ │ │ │ 👤 Bob · 1 hour ago         │   │ │
│ │ │ │ Confirmed, pricing is valid. │   │ │
│ │ │ └─────────────────────────────┘   │ │
│ │ └───────────────────────────────────┘ │
│ │                                       │
│ │ ┌─ Log Entry ───────────────────────┐ │
│ │ │ 🔄 State: draft → submitted       │ │
│ │ │    by Alice · 3 hours ago          │ │
│ │ └───────────────────────────────────┘ │
│ │                                       │
│ │ [Load more...]                        │
│ └───────────────────────────────────────┘
└─────────────────────────────────────────┘
```

### 9.2 Component Breakdown

| Component | Purpose |
|-----------|---------|
| `ChatterPanel` | Container with tabs, message list, composer. Takes `schemaName` + `recordId` props. |
| `MessageComposer` | Rich text input (Markdown), file drag-and-drop, @mention autocomplete, send button. |
| `MessageItem` | Single message display: avatar, author, timestamp, body (rendered Markdown), attachments, reactions, reply button. |
| `ThreadView` | Indented reply list under a parent message. |
| `LogEntry` | Compact display for system log entries (icon + summary + timestamp). |
| `FollowerBar` | "Following" toggle + follower avatar list. Shown above or beside the chatter panel. |
| `NotificationBell` | Header icon with unread count badge. Dropdown shows recent notifications. |
| `AttachmentPreview` | Inline preview for images, download link for other file types. |

### 9.3 Integration with AutoForm

The `ChatterPanel` is injected into the form page layout. The capability declares a `formPanel` extension:

```typescript
extensions: {
  formPanels: [
    {
      name: "chatter",
      label: "Chatter",
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

`cap-adapter-ui-react` reads `formPanels` extensions from all installed capabilities and renders them in the appropriate slot on the form page. No changes to core form layout logic needed.

### 9.4 @Mention Autocomplete

The composer uses a mention plugin that:

1. Triggers on `@` character in the text input
2. Queries a user search endpoint (provided by `cap-auth` or a user directory service)
3. Shows a dropdown of matching users
4. Inserts `@[Display Name](user:user_id)` into the Markdown body
5. Adds the user to the `mentions` array on submit

## 10. Capability Structure

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
        auto-log.ts            # EventHandler for auto-logging
        auto-follow.ts         # EventHandler for auto-following creators
        mention-notify.ts      # EventHandler for @mention notifications
      rest/
        attachment-routes.ts   # Upload/download REST endpoints
    ui/
      components/
        chatter-panel.tsx
        message-composer.tsx
        message-item.tsx
        thread-view.tsx
        log-entry.tsx
        follower-bar.tsx
        notification-bell.tsx
        attachment-preview.tsx
      hooks/
        use-chatter.ts         # Data fetching + subscription hook
        use-notifications.ts   # Notification state hook
    package.json
    tsconfig.json
```

### 10.1 Capability Definition

```typescript
import { defineCapability } from "@linchkit/core";

export default defineCapability({
  name: "chatter",
  label: "Chatter & Collaboration",
  description: "Record-level messaging, activity logging, and team collaboration",
  type: "standard",
  category: "system",
  version: "0.1.0",

  dependencies: [],   // Works without cap-auth (uses anonymous actor)
  optionalDependencies: ["cap-auth"],  // Enhances with user resolution

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
        label: "Chatter",
        position: "below",
        component: "ChatterPanel",
      },
    ],
  },
});
```

## 11. Permissions

When `cap-permission` is installed, chatter respects the following permission rules:

| Action | Default Permission | Notes |
|--------|-------------------|-------|
| View comments | Read access on the schema | If you can see the record, you can see comments |
| Post comment | Read access on the schema | Viewers can comment |
| Post note | Write access on the schema | Notes are team-internal |
| Edit message | Own message only, within 15 min | Configurable window |
| Delete message | Own message, or admin role | Admin can delete any message |
| Follow/unfollow | Read access on the schema | Anyone with access can follow |
| Upload attachment | Read access on the schema | File size limits apply |
| View log entries | Read access on the schema | Logs are always visible |

When `cap-permission` is not installed, all operations are allowed (open mode, consistent with the rest of LinchKit).

## 12. Configuration

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
      excludeFields: string[],      // Fields to omit from change logs (e.g., ["_version"])
    },

    // Auto-follow
    autoFollow: {
      creator: boolean,             // Default: true
      assignee: boolean,            // Default: true
      assigneeField: string,        // Default: "assigned_to"
    },

    // UI
    ui: {
      defaultTab: "all" | "comments" | "notes" | "log",  // Default: "all"
      showFollowerBar: boolean,     // Default: true
      enableReactions: boolean,     // Default: true
      enableThreading: boolean,     // Default: true
    },
  },
}
```

## 13. MCP Integration

When `cap-adapter-mcp` is installed, chatter exposes additional MCP tools:

| Tool | Description |
|------|-------------|
| `list_messages` | List messages for a schema + record (with type filter) |
| `add_comment` | Post a comment on a record |
| `add_note` | Post an internal note on a record |
| `get_activity_log` | Get the auto-generated activity log for a record |
| `follow_record` | Follow a record for notifications |

This enables AI agents to participate in record discussions, post analysis results as notes, and monitor record activity.

## 14. Performance Considerations

- **Pagination**: All message queries are paginated (default 20, max 100). No unbounded queries.
- **Denormalization**: `author_name`, `thread_count` are denormalized to avoid joins on hot paths.
- **DataLoader**: GraphQL resolvers use DataLoader for batching attachment and author lookups (consistent with Link resolver pattern).
- **Attachment streaming**: File downloads stream directly from storage backend, not buffered in memory.
- **Index strategy**: Primary index on `(schema_name, record_id, created_at DESC)` covers the main query pattern. GIN index on `mentions` for @mention queries.
- **Soft delete filter**: Queries default to `is_deleted = false`. Explicit flag to include deleted messages (admin use).

## 15. Migration & Rollback

- Installing `cap-chatter` runs `drizzle-kit generate` + `migrate` to create the three system tables in `_linchkit` schema.
- Uninstalling does NOT drop tables (data preservation). Tables become inert.
- Re-installing picks up existing data seamlessly.

## 16. Future Extensions (Out of Scope for M3)

| Feature | Description | Milestone |
|---------|-------------|-----------|
| Email notifications | Send email on new messages to followers | M4 |
| Webhook delivery | POST notification payloads to external URLs | M4 |
| Slack/Teams integration | Forward messages to channels | M4+ (separate capability) |
| Rich text editor | WYSIWYG instead of Markdown (e.g., Tiptap) | M4 |
| Message search | Full-text search across all messages | M4 |
| Pinned messages | Pin important messages to top of feed | M4 |
| AI summary | AI-generated summary of discussion thread | M4+ |
| Read receipts | Track who has read which messages | M4+ |
