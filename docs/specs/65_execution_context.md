# Execution Context (Global Context Propagation)

> Tracking milestones:
> - M5: Core types + CommandLayer integration + transport meta passing + propagation
> - M6: Rule meta conditions + EventHandler meta access + MCP meta injection + execution log recording
>
> Related specs:
> - `04_action.md` — Action definition, handler, ActionContext
> - `16_command_layer_and_api.md` — CommandLayer pipeline, ExecutionOptions, transport adapters
> - `39_execution_contract.md` — Unified execution contract, parent-child executions
> - `07_event.md` / `08_event_handler_and_queue.md` — Event model, EventHandler context
> - `05_rule.md` — Rule conditions and effects
>
> Execution source of truth: GitHub milestones and issues.

## 1. Problem Statement

LinchKit's `ActionContext` provides structured access to actor, tenantId, logger, AI service,
and data operations. However, there is no **generic context propagation mechanism** — a way to
pass arbitrary metadata through the entire execution chain (Action -> EventHandler -> Rule ->
nested Action calls).

### Current gaps

1. **No cross-cutting metadata propagation** — No way to pass contextual flags from the caller
   to deeply nested actions. Example: "this operation is part of a bulk import, skip email
   notifications."

2. **No view context from frontend** — When the user clicks "Approve" from the approval queue
   view, the server has no standard way to know which view the user was in.

3. **No integration source metadata** — Beyond `channel`, there is no structured way for
   adapters to pass source information (e.g., MCP client ID, webhook source).

4. **No context-dependent defaults** — Default values that depend on context (e.g., "default
   department = user's department") have no standard mechanism.

5. **No metadata propagation through `ctx.execute()`** — When Action A calls Action B via
   `ctx.execute()`, there is no way to forward custom flags like `skip_notifications` or
   `triggered_by`.

### Current state

The `CommandContext` already has a `meta: Record<string, unknown>` field and
`CommandExecuteOptions` accepts `meta?: Record<string, unknown>`. However, this meta is
**not typed**, **not propagated** through `ctx.execute()` in ActionContext, **not accessible**
from Rules or EventHandlers, and has **no standard key conventions**. This spec formalizes
and extends the existing raw meta into a first-class propagation mechanism.

## 2. Design: ExecutionMeta

Add a structured, immutable `meta` property to `ActionContext` that carries arbitrary key-value
metadata through the entire execution chain.

### 2.1 Type definitions

```typescript
/**
 * Immutable execution metadata that propagates through the entire execution
 * chain (Action -> EventHandler -> nested Actions).
 * Used for cross-cutting concerns, caller hints, and integration metadata.
 */
interface ExecutionMeta {
  /** Get a metadata value by key */
  get<T = unknown>(key: string): T | undefined;

  /** Get a metadata value, throwing if not present */
  require<T = unknown>(key: string): T;

  /** Check if a key exists */
  has(key: string): boolean;

  /** Get all metadata as a plain object (shallow copy) */
  toJSON(): Record<string, unknown>;
}
```

### 2.2 ActionContext extension

```typescript
interface ActionContext {
  // ... existing fields (input, actor, tenantId, logger, ai, etc.) ...

  /**
   * Execution metadata — arbitrary key-value context that propagates through
   * the entire execution chain (Action -> EventHandler -> nested Actions).
   * Read-only after construction.
   */
  meta: ExecutionMeta;

  // Extended execute signature to accept meta
  execute(
    actionName: string,
    input: Record<string, unknown>,
    options?: { meta?: Record<string, unknown> },
  ): Promise<unknown>;
}
```

### 2.3 Reference implementation

```typescript
class ExecutionMetaImpl implements ExecutionMeta {
  private readonly data: ReadonlyMap<string, unknown>;

  constructor(entries: Record<string, unknown>) {
    this.data = new Map(Object.entries(entries));
  }

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  require<T = unknown>(key: string): T {
    if (!this.data.has(key)) {
      throw new Error(`Required meta key "${key}" not found`);
    }
    return this.data.get(key) as T;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  toJSON(): Record<string, unknown> {
    return Object.fromEntries(this.data);
  }

  /**
   * Create a child meta by extending with additional keys.
   * Parent keys cannot be overridden; system keys (_-prefixed) are
   * updated by the framework only.
   */
  extend(extra: Record<string, unknown>, systemOverrides?: Record<string, unknown>): ExecutionMetaImpl {
    const merged: Record<string, unknown> = { ...this.toJSON() };
    for (const [k, v] of Object.entries(extra)) {
      // Cannot override existing keys
      if (!merged[k]) {
        merged[k] = v;
      }
    }
    // System overrides always applied
    if (systemOverrides) {
      Object.assign(merged, systemOverrides);
    }
    return new ExecutionMetaImpl(merged);
  }
}
```

## 3. Setting Metadata — Entry Points

### 3.1 From REST API

Meta is passed via the `X-Linch-Meta` header as a JSON object:

```
POST /api/actions/approve_request
Authorization: Bearer <token>
X-Linch-Meta: {"source_view": "approval_queue", "bulk": true}
Content-Type: application/json

{"id": "pr_001"}
```

The REST adapter parses the header and injects it into `CommandExecuteOptions.meta`.

### 3.2 From GraphQL

Meta is passed as an optional argument on action mutations:

```graphql
mutation {
  approve_request(input: { id: "pr_001" }, meta: { source_view: "approval_queue" }) {
    success
    data
  }
}
```

The GraphQL adapter extracts `meta` from the mutation arguments and injects it into
`CommandExecuteOptions.meta`.

### 3.3 From MCP adapter

The MCP adapter automatically sets system meta keys and passes through any
client-provided meta:

```typescript
// MCP adapter injects automatically:
meta = {
  _channel: "mcp",
  _mcp_client_id: clientRegistration.id,
  ...clientProvidedMeta,
};
```

### 3.4 From code (Action calling another Action)

When an action handler calls `ctx.execute()`, it can pass additional meta that extends
(but does not override) the current execution's meta:

```typescript
// In action handler:
await ctx.execute("send_notification", { to: userId, message: "..." }, {
  meta: { skip_email: true, triggered_by: "bulk_import" },
});
```

### 3.5 From CLI

```bash
linch exec approve_request --input '{"id":"pr_001"}' --meta '{"bulk":true}'
```

## 4. Propagation Rules

### 4.1 Downward propagation

Meta propagates **downward** through the execution chain:

```
REST/GraphQL/MCP/CLI (sets initial meta)
  -> CommandLayer (adds system keys)
    -> Action handler (reads meta via ctx.meta)
      -> Rule evaluation (reads meta)
      -> EventHandler (receives meta from original action's execution context)
      -> ctx.execute() child Action (inherits parent meta + extensions)
```

### 4.2 Immutability

Meta is **read-only** once constructed. Action handlers, Rules, and EventHandlers cannot
modify the meta. This prevents spooky action at a distance where a deeply nested handler
changes context that affects a sibling handler.

### 4.3 Extension on nested calls

Each nested `ctx.execute()` call can **extend** meta (add new keys) but **cannot override**
existing keys from the parent. This prevents a child action from altering the intent
established by the caller.

```typescript
// Parent action sets meta: { bulk: true, source: "import" }
// Child execute call:
await ctx.execute("validate_item", { id }, {
  meta: { validation_mode: "strict" },
});
// Child action sees: { bulk: true, source: "import", validation_mode: "strict" }

// Attempting to override is silently ignored:
await ctx.execute("validate_item", { id }, {
  meta: { bulk: false },  // Ignored — parent already set bulk=true
});
// Child action sees: { bulk: true, source: "import" }
```

### 4.4 System keys

Keys prefixed with `_` are system-managed and cannot be set or overridden by external
callers (REST headers, GraphQL args, MCP context, CLI flags). The framework strips
any `_`-prefixed keys from user-provided meta before merging.

System keys are set by the CommandLayer and updated by the framework on nested calls:

| Key | Type | Set by | Description |
|-----|------|--------|-------------|
| `_channel` | `ExecutionChannel` | CommandLayer | Transport channel (`rest` / `graphql` / `mcp` / `internal`) |
| `_execution_id` | `string` | CommandLayer | Root execution ID |
| `_depth` | `number` | ActionEngine | Nesting depth (0 = root action) |
| `_source_action` | `string` | ActionEngine | Calling action name (only set on nested calls) |
| `_mcp_client_id` | `string` | MCP adapter | MCP client registration ID (only when channel = mcp) |

## 5. Well-Known Meta Keys

Standard keys that capabilities can rely on. These are conventions, not enforced types —
capabilities check for their presence and interpret them accordingly.

| Key | Type | Set by | Purpose |
|-----|------|--------|---------|
| `lang` | `string` | Caller | Language override for this execution (e.g., `"zh-CN"`) |
| `tz` | `string` | Caller | Timezone override (e.g., `"Asia/Shanghai"`) |
| `source_view` | `string` | Frontend | Which view the user was in when triggering the action |
| `bulk` | `boolean` | Caller | Whether this is part of a bulk operation |
| `skip_notifications` | `boolean` | Caller | Skip notification side effects |
| `dry_run` | `boolean` | Caller | Execute without persisting (for preview/validation) |
| `default.*` | `unknown` | Caller | Default field values (e.g., `default.department_id`) |
| `triggered_by` | `string` | Caller | Human-readable trigger source (e.g., `"scheduler"`, `"webhook"`) |
| `trace_context` | `Record<string, string>` | System/Caller | OpenTelemetry W3C trace context for distributed tracing |

### 5.1 Relationship between `lang` / `tz` and existing fields

`ActionContext` already has a `locale` field (from `CommandExecuteOptions.locale`). The
`meta.lang` key is for **action-level overrides** — if an action needs to generate content
in a different language than the session locale. If `meta.lang` is not set, handlers should
fall back to `ctx.locale ?? "en"`.

Similarly, `meta.tz` is for action-level timezone overrides, not a replacement for any
session-level timezone.

## 6. Usage in Rules

Rules can reference meta values in their conditions using the `meta` namespace:

```typescript
defineRule({
  name: "skip_approval_for_bulk",
  entity: "purchase_request",
  trigger: { action: "submit_request" },
  condition: {
    operator: "and",
    conditions: [
      { field: "meta.bulk", operator: "eq", value: true },
      { field: "amount", operator: "lt", value: 1000 },
    ],
  },
  effect: {
    type: "gate",
    allow: true,
    message: "Bulk imports under 1000 skip approval",
  },
});
```

The Rule engine resolves `meta.*` fields by reading from the current execution's
`ExecutionMeta` rather than from the entity record.

## 7. Usage in EventHandlers

EventHandlers receive the meta from the originating action's execution context.
The `EventHandlerContext` is extended to include meta:

```typescript
interface EventHandlerContext {
  emit(eventType: string, payload: Record<string, unknown>): void;

  /** Execution metadata from the action that produced this event */
  meta: ExecutionMeta;
}
```

Example:

```typescript
defineEventHandler({
  name: "send_approval_email",
  listen: "purchase_request.approved",
  handler: async (event, ctx) => {
    // Skip email if caller explicitly requested it
    if (ctx.meta.get<boolean>("skip_notifications")) return;

    await sendApprovalEmail(event.payload.id);
  },
});
```

## 8. Implementation in CommandLayer

### 8.1 Construction

The CommandLayer constructs `ExecutionMeta` from three sources, in priority order
(later sources cannot override earlier ones):

1. **System keys** — `_channel`, `_execution_id`, `_depth` (always set by framework)
2. **Transport-provided meta** — from REST `X-Linch-Meta` header, GraphQL `meta` argument,
   MCP context, or CLI `--meta` flag (user `_`-prefixed keys stripped)
3. **Caller-provided meta** — from `ctx.execute()` calls in action handlers

```typescript
// In CommandLayer.execute():
const rawMeta = { ...(execOptions.meta ?? {}) };

// Strip system keys from user input
for (const key of Object.keys(rawMeta)) {
  if (key.startsWith("_")) delete rawMeta[key];
}

// Build final meta
const meta = new ExecutionMetaImpl({
  _channel: execOptions.channel ?? "internal",
  _execution_id: executionId,
  _depth: 0,
  ...rawMeta,
});
```

### 8.2 Propagation through ActionEngine

When `ctx.execute()` creates a child action, the ActionEngine:

1. Takes the parent's `ExecutionMeta`
2. Calls `meta.extend(childMeta, { _depth: parentDepth + 1, _source_action: parentActionName })`
3. Passes the extended meta to the child action's context

```typescript
// In ActionEngine, building the child action context:
const childMeta = parentMeta.extend(
  userProvidedChildMeta ?? {},
  {
    _depth: currentDepth + 1,
    _source_action: parentActionName,
    _execution_id: parentMeta.get("_execution_id"), // Preserve root execution ID
  },
);
```

### 8.3 Integration with existing `CommandContext.meta`

The existing `CommandContext.meta: Record<string, unknown>` is currently used for
middleware-to-middleware communication within the CommandLayer pipeline. This raw dict
remains for internal pipeline use. The typed `ExecutionMeta` is constructed from it
when building `ActionContext` and is what action handlers, rules, and event handlers see.

Relationship:

```
CommandContext.meta (raw dict, mutable within pipeline)
  -> ExecutionMeta (typed, immutable, exposed to action handlers)
```

### 8.4 ExecuteOptions extension

```typescript
interface ExecuteOptions {
  channel?: ExecutionChannel;
  // ... existing fields ...

  /** Execution metadata to propagate through the execution chain */
  meta?: Record<string, unknown>;
}
```

## 9. Execution Log Recording

Meta is included in execution log records for audit and debugging:

```typescript
interface ExecutionRecord {
  // ... existing fields ...

  /** Execution metadata snapshot at time of execution */
  meta?: Record<string, unknown>;
}
```

This enables:
- **Audit** — "Who triggered this bulk import and from which view?"
- **Debugging** — "Was `skip_notifications` set when this action ran?"
- **Analytics** — "How many actions are triggered from the MCP adapter vs the UI?"

## 10. Security

### 10.1 System key protection

Keys prefixed with `_` are system-only. External callers (REST, GraphQL, MCP, CLI) cannot
set them. The transport adapter strips all `_`-prefixed keys before passing to CommandLayer.

### 10.2 Size limit

Meta is limited to **8 KB** (JSON-serialized size). If the limit is exceeded, the transport
adapter rejects the request with a `ValidationError` before entering the CommandLayer pipeline.

### 10.3 Audit logging

Meta is recorded in execution logs. Sensitive meta keys can be configured for masking
in log output:

```typescript
// In linchkit.config.ts
export default defineConfig({
  execution: {
    meta: {
      maskedKeys: ["auth_token", "api_secret"],
    },
  },
});
```

Masked keys are stored as `"***"` in execution log records but remain available in-memory
during the execution chain.

### 10.4 No arbitrary code execution

Meta values must be JSON-serializable primitives, arrays, or plain objects. Functions,
class instances, Symbols, and other non-serializable values are stripped during construction.

## 11. Relationship to Existing Concepts

| Concept | How it differs from ExecutionMeta |
|---------|----------------------------------|
| `ActionContext.input` | Action-specific data (the "what"). Meta is cross-cutting context (the "how/why"). |
| `ActionContext.tenantId` | A specific, typed field. Meta is a generic extensible container. |
| `ActionContext.locale` | A specific, typed field for session locale. Meta `lang` is for action-level override. |
| `EventRecord.payload` | Event-specific data. Meta flows through the execution chain, not just events. |
| `CommandContext.meta` | Raw mutable dict for pipeline middleware. ExecutionMeta is typed, immutable, for handlers. |
| HTTP headers | Transport-specific. ExecutionMeta is transport-agnostic. |
| `ExecuteOptions` | Options for the engine. Meta is semantic context for business logic. |

## 12. What NOT to Do

- **Don't use meta for business data** — Business data goes in Action `input`. Meta is for
  cross-cutting context like "is this bulk?" or "skip notifications."
- **Don't make meta mutable** — It is read-only after construction. If you need to communicate
  state between handlers, use the event system.
- **Don't use meta as a replacement for proper API design** — If something should be an
  explicit field on ActionContext or ActionDefinition, make it a proper field.
- **Don't propagate meta across process boundaries unless explicitly requested** — For
  example, when a Flow step triggers via Restate, meta is not automatically serialized
  into the Restate call. Flows that need meta propagation must explicitly include it in
  their step input.
- **Don't store large payloads in meta** — The 8 KB limit exists for a reason. Files,
  blobs, and large JSON structures do not belong in meta.

## 13. Migration Path

### From current `CommandContext.meta`

The existing `meta: Record<string, unknown>` on `CommandContext` continues to work as-is
for middleware communication. The change is additive:

1. `CommandContext.meta` remains a raw mutable dict (internal to pipeline)
2. `ActionContext.meta` becomes `ExecutionMeta` (typed, immutable, exposed to handlers)
3. `EventHandlerContext.meta` is added (typed, immutable, from originating action)
4. `ctx.execute()` gains an optional `options.meta` parameter

No breaking changes to existing code. Existing middleware that writes to
`CommandContext.meta` continues to work. The only new behavior is that `ActionContext.meta`
is now a structured object instead of absent.

## 14. Milestones

### M5

- `ExecutionMeta` type and `ExecutionMetaImpl` class in `@linchkit/core`
- `ActionContext.meta: ExecutionMeta` field
- `ctx.execute()` extended to accept `options.meta`
- CommandLayer constructs `ExecutionMeta` from `CommandContext.meta`
- REST adapter: parse `X-Linch-Meta` header
- GraphQL adapter: accept `meta` argument on action mutations
- CLI: `--meta` flag on `linch exec`
- System key (`_` prefix) stripping from external input
- 8 KB size limit enforcement
- Meta included in execution log records

### M6

- Rule engine: resolve `meta.*` fields in conditions
- EventHandlerContext: add `meta: ExecutionMeta`
- MCP adapter: auto-inject `_mcp_client_id` and forward client meta
- Config: `execution.meta.maskedKeys` for audit log masking
- Well-known key documentation and validation helpers
