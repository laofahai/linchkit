# Spec 66: Event Lifecycle Management

> Tracking milestones:
> - M5: Event deduplication + execution log partitioning + tiered retention (hot/warm)
> - M6: Event archival (external storage), cleanup job, audit compliance mode
> - M7: Event replay tooling (CLI + DevTools UI), aggregation table
>
> Related specs:
> - `07_event.md` — Event model, event types, payload structure
> - `08_event_handler_and_queue.md` — EventHandler, Outbox, retry, ordering
> - `11_execution_log.md` — Execution log structure, storage, retention overview
> - `28_observability.md` — Observability layer, metrics, alerts
> - `23_rule_engine_and_flow.md` — Restate Flow engine, Saga, idempotency
>
> Related issues: #134 (archival), #135 (deduplication), #137 (replay), #120 (execution log governance)
>
> Execution source of truth: GitHub milestones and issues.

## 1. Overview

The event system is LinchKit's backbone: every Action, Rule evaluation, and state transition emits
events that drive the Outbox, EventHandler dispatch, AI analysis, and audit trails. As systems
scale, three lifecycle concerns emerge that must be addressed together because they are tightly
coupled:

- **Deduplication** — retried Actions can emit duplicate events; handlers must not double-fire.
- **Archival & Retention** — event tables grow unboundedly; data must age through hot→warm→cold.
- **Replay & Debugging** — operators need to re-examine and re-dispatch past events for incident
  recovery, testing, and system analysis.

These three concerns also apply to the **Execution Log** (`_linchkit.executions`), which shares
the same data-lifecycle pressures. This spec defines them as a unified framework rather than
three independent subsystems.

## 2. Event Deduplication

### 2.1 Problem

The Outbox worker applies at-least-once delivery: if a worker crashes after executing a handler
but before committing the completion, the outbox row stays `pending` and the handler fires again.
Additionally, upstream systems retrying an Action (e.g., HTTP retry after a network timeout) may
produce a second `action.succeeded` event for the same logical operation.

### 2.2 Idempotency Key Design

Every event record carries an **idempotency key** — a stable, deterministic identifier for the
logical event occurrence. Two records with the same idempotency key represent the same logical
event and at most one handler invocation should proceed.

```typescript
interface EventRecord {
  // ... existing fields from Spec 07 ...
  idempotency_key: string; // derived, see §2.3
}
```

The idempotency key is computed at event emission time and stored in the events table. It is
indexed for O(1) dedup lookup.

### 2.3 Key Derivation

| Event category | Derivation |
|----------------|------------|
| Framework runtime events (`action.*`, `record.*`, `state.*`) | `sha256(execution_id + ":" + event_type + ":" + (record_id \|\| "") + ":" + seq)` where `seq` is a per-(execution, event_type, record_id) monotonic counter, starting at 0, incremented each time the same combination is emitted within the same execution |
| Custom events emitted via `ctx.emit()` | `sha256(execution_id + ":" + event_type + ":" + caller_stable_id)` where `caller_stable_id` is a caller-supplied string (defaults to sequence number within execution) |
| Restate Flow step events | Restate's built-in idempotency key is forwarded directly — no additional derivation needed |

> **Retry stability note:** `execution_id` is allocated at the beginning of each `Action.execute()` call.
> A retried action receives a **new** `execution_id`, so its events get new idempotency keys and bypass
> the dedup window correctly — re-emission after a retry is the expected behavior. The dedup window
> (§2.5) guards only against double-dispatch of the *same* outbox entry (e.g. a crashed worker
> re-claiming it), not against logically distinct retry attempts.

For **Restate-orchestrated flows** (Spec 23), Restate already provides durable exactly-once
semantics for step execution. The dedup layer below applies only to non-Restate paths (direct
Action execution, Outbox workers). Restate events pass through without additional dedup overhead.

### 2.4 Dedup Check in Outbox Worker

Before dispatching an outbox entry to an EventHandler, the worker checks whether the event's
idempotency key has already been successfully processed by that handler:

```text
outbox_completions(event_idempotency_key, handler_name) → completed_at
```

A separate `outbox_completions` table records successful handler completions (event idempotency
key + handler name). If a record exists, the worker marks the outbox entry `completed` without
re-executing the handler.

```sql
CREATE TABLE _linchkit.outbox_completions (
  event_idempotency_key TEXT NOT NULL,
  handler_name          TEXT NOT NULL,
  completed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_idempotency_key, handler_name)
);
```

### 2.5 Dedup Window

To bound `outbox_completions` table growth, completions older than the **dedup window** are
eligible for cleanup by the retention job (§4). The default window is **72 hours** — wide enough
to cover any realistic retry storm, conservative enough to avoid unbounded growth.

Configurable per-deployment:

```typescript
// linchkit.config.ts
export default defineConfig({
  events: {
    dedup: {
      windowHours: 72, // default
    },
  },
})
```

### 2.6 Interaction with Restate

Restate's durable execution already guarantees exactly-once step execution within a Flow. When an
EventHandler is registered as a Restate workflow step, the Restate-level guarantee supersedes the
outbox dedup — the `outbox_completions` check is skipped for Restate-backed handlers to avoid
double-write overhead. The EventHandler definition declares this via `runtime: 'restate'`.

## 3. Event Archival & Retention

### 3.1 Event Table Partitioning

The `_linchkit.events` table uses **monthly range partitioning** on `timestamp`. Partition creation
is automated: a scheduled job creates next-month's partition in advance (runs on the 20th of each
month).

```sql
CREATE TABLE _linchkit.events (
  -- ... fields from Spec 07 ...
) PARTITION BY RANGE (timestamp);

-- Auto-created monthly partitions:
-- _linchkit.events_2026_05
-- _linchkit.events_2026_06
-- ...
```

Indexes (type, schema, record_id, execution_id, timestamp, idempotency_key) are created per
partition. Dropping an old partition drops its indexes atomically — no manual index maintenance.

### 3.2 Retention Tiers

Events progress through three tiers based on age, configurable per tenant:

| Tier | Default age | Storage | Query capability |
|------|-------------|---------|------------------|
| **Hot** | 0–90 days | Full record in main partitions | Real-time, all fields |
| **Warm** | 90 days–12 months | Main partition (payload stripped to summary) | Queryable, no payload detail |
| **Cold** | 12 months+ | Archived to `_linchkit.events_archive` or external object storage | Bulk-read only; payload from archive |

**Warm transition** strips the `payload` JSONB column (moves to `_linchkit.events_payload_archive`
keyed by event ID) to reduce table bloat while preserving the event skeleton for audit queries.
`_linchkit.events_payload_archive` uses the **same monthly range partitioning** strategy (on
`archived_at TIMESTAMPTZ`) so its own Cold transition can drop old partitions atomically.

**Cold transition** moves entire old partition rows to an append-only archive table (or exports to
object storage such as S3/GCS). The main partition is dropped after archival is verified.

### 3.3 Retention Configuration

```typescript
// linchkit.config.ts
export default defineConfig({
  events: {
    retention: {
      hotDays: 90,       // default; days before warm transition
      warmDays: 365,     // days before cold transition
      coldStrategy: 'archive_table', // 'archive_table' | 'object_storage' | 'delete'
      // Per-event-type overrides:
      overrides: [
        { type: 'action.succeeded', hotDays: 180 }, // keep full records longer
        { type: 'rule.evaluated', hotDays: 30 },    // routine noise, age faster
      ],
    },
  },
})
```

Per-tenant overrides are stored in the tenant config (Spec 30) and applied at the row level
during cleanup job execution.

### 3.4 Compliance Mode

Regulated tenants can opt into compliance mode, which prevents deletion of any event records
regardless of retention policy. In compliance mode:
- Cold events are copied to archive (not deleted from main partitions)
- A `retained_permanently` flag marks records exempt from cleanup
- Events with `category: 'change'` (Proposal events, approval decisions) are always retained
  permanently, regardless of compliance mode

### 3.5 GDPR / Right-to-Erasure

The `actor.id` field on events is used for GDPR erasure requests. When a user requests erasure:
1. The `actor.id` field is replaced with a pseudonymous token (`gdpr_erased_<hash>`)
2. Any PII in `payload` is nullified according to the entity's field masking config (Spec 41a)
3. The event skeleton (type, timestamp, execution_id, schema, record_id) is retained for audit
   integrity
4. The erasure action itself is recorded as a `gdpr.erasure_applied` framework event

This satisfies audit requirements (the operation happened, at what time, on what record) without
retaining personal data.

## 4. Event Replay & Debugging

### 4.1 Replay Scope

Replay re-emits past events to the event bus so registered EventHandlers can re-process them.
Three replay scopes are supported:

| Scope | Description |
|-------|-------------|
| **Single event** | Re-emit one event by ID |
| **Execution** | Re-emit all events belonging to an `execution_id` |
| **Time range + filter** | Re-emit events matching type/schema/record_id within a time window |

### 4.2 Replay Modes

**Dry-run** (`--dry-run`): Simulates dispatch without invoking handler side effects. The engine
logs which handlers would fire, what payload they would receive, and whether idempotency keys
would pass the dedup check. No database writes occur outside the replay log.

**Live** (`--live`): Actually re-dispatches events to the Outbox. Each replayed event receives a
new `replay_id` in its metadata (Spec 65 ExecutionMeta key `replay.originEventId`) so handlers
can detect replay context and skip non-idempotent side effects (e.g., sending emails).

### 4.3 Replay Safety Guards

To prevent unintended cascade effects:

1. **Replay context flag**: Replayed events carry `meta.replay = { originEventId, replayId, dryRun }`.
   EventHandlers can check `ctx.meta.get('replay')` and skip external calls when replaying.

2. **Action execution guard**: Replay does **not** re-execute the originating Action — only the
   events are re-dispatched. If a handler triggers a child Action via `ctx.execute()`, that Action
   runs normally (including all Rules) unless the handler itself suppresses it based on replay
   context.

3. **Dedup bypass option**: By default, replay skips events whose idempotency keys already appear
   in `outbox_completions` for the target handler. Pass `--force` to override for explicit
   re-processing (e.g., bug-fix replay where prior processing was incorrect).

4. **Scope limits**: Time-range replay is capped at 10,000 events per invocation to prevent
   accidental runaway. Larger replays require explicit `--limit-override N`.

### 4.4 CLI Tooling

```bash
# Inspect a single event (shows payload, handlers that would fire, dedup status)
linch event inspect <event-id>

# Replay a single event (dry-run by default)
linch event replay <event-id>
linch event replay <event-id> --live

# Replay all events from an execution
linch event replay --execution <execution-id>

# Replay events by filter + time range
linch event replay \
  --type record.updated \
  --schema purchase_request \
  --record <record-id> \
  --from 2026-05-01T00:00:00Z \
  --to   2026-05-08T23:59:59Z \
  --live

# List recent dead-letter events (failed after max retries)
linch event dead-letter list
linch event dead-letter replay <outbox-id>
```

### 4.5 DevTools UI

The DevTools event timeline panel (accessible per-record via the Chatter timeline, Spec 53) gains:

- **Event history tab**: Full event list for a record with type, timestamp, handler dispatch status
- **Handler execution tree**: Shows which handlers fired, their status (completed/failed/retried),
  and retry history
- **Replay button**: Triggers a dry-run replay for a selected event, showing results inline
- **Dead-letter viewer**: Lists failed outbox entries for a record, with manual replay and
  dismiss controls

## 5. Cross-Cutting Concerns

### 5.1 Feature Interaction Matrix

| | Deduplication | Archival | Replay |
|---|---|---|---|
| **Dedup** | — | Dedup window cleaned by retention job | Replay generates new idempotency keys unless `--force` |
| **Archival** | Archived events lose hot-tier queryability | — | Replay from archive requires `--from-archive` flag; warm-tier events replay without payload |
| **Replay** | Replayed events re-enter dedup check | Replay scope limited to hot/warm tiers by default | — |

### 5.2 Configuration Surface

All three features share a unified config namespace:

```typescript
// linchkit.config.ts
export default defineConfig({
  events: {
    dedup: {
      windowHours: 72,
    },
    retention: {
      hotDays: 90,
      warmDays: 365,
      coldStrategy: 'archive_table',
      overrides: [],
    },
    replay: {
      defaultMode: 'dry-run', // safety: dry-run unless overridden
      scopeLimit: 10_000,
    },
  },
})
```

Per-tenant overrides live in tenant config (Spec 30) and take precedence over global defaults.

### 5.3 Performance Implications

- **Dedup**: The `outbox_completions` lookup adds one indexed read per handler dispatch. At 1,000
  events/second with 2 handlers average, this is ~2,000 indexed reads/second — well within
  PostgreSQL's capabilities. The cleanup job (§6.3) keeps the table bounded.

- **Partitioning**: Monthly partition scans replace full-table scans. Queries specifying a
  timestamp range hit only the relevant partition(s). Index sizes are bounded per partition.

- **Replay**: Dry-run replay is read-only and does not acquire write locks. Live replay throttles
  dispatch at a configurable rate (default: 100 events/second) to avoid saturating the Outbox
  worker pool.

## 6. Execution Log Governance

The `_linchkit.executions` table (Spec 11) faces the same data-lifecycle pressures as events.
This section extends Spec 11's retention overview with concrete implementation requirements.

### 6.1 Table Partitioning

Partition `_linchkit.executions` by `started_at` using monthly range partitioning, identical to
the events table strategy (§3.1). The same automated partition-creation job covers both tables.

### 6.2 Tiered Retention

| Tier | Default age | Hot fields retained | Cold fields |
|------|-------------|---------------------|-------------|
| **Hot** | 0–90 days | All fields (input, output, changes, rulesEvaluated) | — |
| **Warm** | 90 days–12 months | Summary columns only (action, actor, status, duration, started_at) | input/output/changes → `_linchkit.execution_details` keyed by execution_id |
| **Cold** | 12 months+ | — | Aggregate into `execution_log_daily_stats` or archive to external storage |

**Warm transition**: The large JSONB columns (`input`, `output`, `changes`, `rulesEvaluated`) are
moved to a separate `_linchkit.execution_details` table. The main executions row keeps summary
columns for dashboards and AI Insight queries without loading full payloads.
`_linchkit.execution_details` uses the **same monthly range partitioning** strategy (on
`transitioned_at TIMESTAMPTZ`) so its own Cold transition can drop old partitions atomically,
mirroring the approach for `_linchkit.events_payload_archive` (§3.2).

**Cold transition**: Rows aggregated into `execution_log_daily_stats` (§6.5) and then archived
or purged from the main table (per `coldStrategy` config).

### 6.3 Cleanup Job

A scheduled capability (`cap-lifecycle-cleanup`, autoInstall when `cap-audit` is installed) runs
the Hot→Warm→Cold transitions:

```text
Schedule: daily at 02:00 local time (configurable)
Algorithm:
  1. For each tenant (or globally if single-tenant):
     a. Identify warm-candidate rows (age > hotDays, still has JSONB columns)
     b. Move JSONB columns to execution_details; null them on main row
     c. Identify cold-candidate rows (age > warmDays)
     d. Aggregate into execution_log_daily_stats
     e. Archive or delete cold rows per coldStrategy
  2. Repeat for events table (§3)
  3. Prune outbox_completions older than dedup window (§2.5)
  4. Emit system event: lifecycle.cleanup_completed with stats
```

The job supports **dry-run mode** (`linch lifecycle cleanup --dry-run`) to preview what would be
transitioned/deleted without committing changes.

### 6.4 Audit Compliance

Certain execution records must never be deleted regardless of age:

- Executions with `status: 'failed'` (failure evidence)
- Executions involving state transitions (state machine audit trail)
- Executions that created, approved, or rejected a Proposal
- Executions during the tenant's compliance retention period (configurable minimum)

These are tagged `retained_permanently = true` at write time and skipped by the cleanup job.

For regulated tenants, **compliance mode** (§3.4) applies the same way: no deletions, only
archival copies. The minimum retention period per compliance regime can be configured:

```typescript
// Per-tenant config (stored in tenant record)
{
  lifecycle: {
    complianceMode: true,
    minimumRetentionDays: 2555, // 7 years for SOX compliance
  }
}
```

### 6.5 Aggregation Table

`_linchkit.execution_log_daily_stats` stores pre-computed daily metrics, populated during the
Cold transition and used by dashboards and the AI Insight engine (Spec 55):

```sql
CREATE TABLE _linchkit.execution_log_daily_stats (
  date        DATE NOT NULL,
  tenant_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  schema      TEXT NOT NULL DEFAULT '', -- '' for global actions not targeting a specific schema

  -- Counters
  total_count       INTEGER NOT NULL DEFAULT 0,
  succeeded_count   INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  blocked_count     INTEGER NOT NULL DEFAULT 0,

  -- Performance
  avg_duration_ms   NUMERIC,
  p50_duration_ms   NUMERIC,
  p95_duration_ms   NUMERIC,

  -- Error rate
  error_rate        NUMERIC GENERATED ALWAYS AS
                      (CASE WHEN total_count > 0
                       THEN failed_count::NUMERIC / total_count
                       ELSE 0 END) STORED,

  PRIMARY KEY (date, tenant_id, action, schema)
);

CREATE INDEX idx_stats_tenant_date ON _linchkit.execution_log_daily_stats (tenant_id, date DESC);
CREATE INDEX idx_stats_action ON _linchkit.execution_log_daily_stats (action, date DESC);
```

### 6.6 Size Estimates

Reference estimates for capacity planning (single tenant, typical workload):

| Workload | Events/day | executions/day | Hot storage/month |
|----------|-----------|----------------|-------------------|
| Small | 10K | 5K | ~0.5 GB |
| Medium | 100K | 50K | ~5 GB |
| Large | 1M | 500K | ~50 GB |

Multi-tenant production multiplies by tenant count. Warm transition reduces storage by ~70%
(JSONB columns are the dominant size). Cold aggregation reduces to kilobytes per day.

## 7. Implementation Phases

### Phase 1 — M5: Foundation

- [ ] Add `idempotency_key` column to `_linchkit.events`; backfill for existing rows
- [ ] Create `_linchkit.outbox_completions` table + index
- [ ] Integrate dedup check into Outbox worker dispatch loop
- [ ] Implement monthly partition creation for `events` and `executions` tables
- [ ] Add `retained_permanently` flag to `executions` table; tag at write time
- [ ] Unit tests: dedup key derivation, dedup window, Restate bypass logic

### Phase 2 — M6: Retention & Archival

- [ ] `_linchkit.execution_details` table for warm-tier payload archival
- [ ] `_linchkit.events_payload_archive` table for warm-tier event payloads
- [ ] `cap-lifecycle-cleanup` scheduled capability with dry-run mode
- [ ] `execution_log_daily_stats` table + aggregation logic in cleanup job
- [ ] Compliance mode: `retained_permanently` enforcement, minimum retention period
- [ ] GDPR erasure: `actor.id` pseudonymization + payload PII nullification
- [ ] `linch lifecycle cleanup --dry-run` CLI command

### Phase 3 — M7: Replay & Debugging

- [ ] `ReplayService` in core: single-event, execution-scoped, time-range replay
- [ ] Replay metadata injection via `ExecutionMeta` (Spec 65)
- [ ] `linch event inspect <id>` — show payload, dedup status, handler dispatch plan
- [ ] `linch event replay` — dry-run and live modes, scope options
- [ ] `linch event dead-letter list/replay` — DLQ management
- [ ] DevTools UI: event timeline tab, handler execution tree, replay button, DLQ viewer
- [ ] Integration tests: replay dry-run does not write; live replay re-enters dedup; force flag bypasses

## 8. Security Considerations

- **Replay authorization**: Only actors with the `system.event.replay` permission can trigger
  live replays. Dry-run requires `system.event.inspect`. Both permissions are off by default;
  explicitly granted to operators via RBAC (Spec 10).

- **Payload exposure**: `linch event inspect` shows full event payloads. Field-level masking
  (Spec 41a) applies: actor-specific fields are redacted if the requesting operator lacks
  the `read` permission for those fields.

- **Archive access**: External object storage archives use the same tenant isolation as the main
  database. Archive URLs are signed (time-limited) and never stored in the database.

- **Cleanup job credentials**: The cleanup job runs under a dedicated service account with
  `DELETE` on event/execution partitions but no `UPDATE` on business entity tables. This limits
  blast radius if the job misbehaves.
