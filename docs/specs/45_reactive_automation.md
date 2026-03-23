# Reactive Automation — Data-Condition Triggers

> Status: Draft | Date: 2026-03-23
> Inspired by: Palantir Automate (object set condition triggers, threshold crossing)
> Milestone: M3

## 1. Problem

LinchKit's current automation is **purely event-driven**: EventHandlers fire when an action succeeds or a state transitions. This misses an important class of automation:

**Data-condition triggers** — "do X when the data reaches a certain state."

Examples that cannot be expressed with current EventHandlers:
- "When total pending purchase requests for a department exceeds ¥100,000, notify the CFO"
- "When inventory count drops below reorder threshold, auto-create a purchase request"
- "When a request has been in 'submitted' state for > 48 hours, escalate"
- "Every Monday 9AM, if there are unapproved requests older than 3 days, send digest"

These require either:
1. Polling + condition evaluation (scheduled)
2. Aggregate-aware triggers (post-action evaluation)
3. Time-based + data-condition combination

## 2. Solution: defineWatcher

Introduce `defineWatcher` — a declaration that combines a data condition with an automated action. Watchers are evaluated on a schedule or after relevant data changes.

```typescript
import { defineWatcher } from '@linchkit/core'

export const budgetAlert = defineWatcher({
  name: 'department_budget_alert',
  label: 'Alert when department spend exceeds budget',

  // WHAT to watch
  watch: {
    schema: 'purchase_request',
    filter: { status: { in: ['submitted', 'approved'] } },
    aggregate: { field: 'amount', op: 'sum', groupBy: 'department_id' },
  },

  // WHEN to trigger
  trigger: {
    type: 'threshold',
    condition: { gt: 100_000 },      // sum(amount) > 100,000
    // Only fire once per group until condition resets
    debounce: 'once_until_reset',
  },

  // WHAT to do
  effect: {
    action: 'send_notification',
    params: (context) => ({
      to: context.group.department.manager,
      template: 'budget_exceeded',
      data: { department: context.group.department_id, total: context.value },
    }),
  },
})
```

## 3. Watcher Types

### 3.1 Threshold Watcher

Fires when an aggregate crosses a boundary.

```typescript
defineWatcher({
  name: 'low_inventory_alert',
  watch: {
    schema: 'inventory_item',
    filter: {},               // all items
    // No aggregate — watches individual records
  },
  trigger: {
    type: 'threshold',
    field: 'quantity',
    condition: { lt: '$reorder_point' },  // field reference
    debounce: 'once_until_reset',
  },
  effect: {
    action: 'create_purchase_request',
    params: (ctx) => ({
      item_id: ctx.record.id,
      quantity: ctx.record.reorder_quantity,
    }),
  },
})
```

### 3.2 Staleness Watcher

Fires when records have been in a certain state too long.

```typescript
defineWatcher({
  name: 'stale_request_escalation',
  watch: {
    schema: 'purchase_request',
    filter: { status: 'submitted' },
  },
  trigger: {
    type: 'staleness',
    field: 'updated_at',
    threshold: '48h',          // stale after 48 hours
  },
  effect: {
    action: 'escalate_request',
    params: (ctx) => ({ id: ctx.record.id }),
  },
})
```

### 3.3 Scheduled + Condition Watcher

Evaluates a condition on a schedule.

```typescript
defineWatcher({
  name: 'weekly_unapproved_digest',
  watch: {
    schema: 'purchase_request',
    filter: { status: 'submitted' },
    // Condition: count > 0
  },
  trigger: {
    type: 'schedule',
    cron: '0 9 * * 1',        // Every Monday 9AM
    condition: { count: { gt: 0 } },
  },
  effect: {
    action: 'send_digest',
    params: (ctx) => ({
      requests: ctx.records,
      count: ctx.count,
    }),
  },
})
```

### 3.4 Set Change Watcher

Fires when records enter or leave a filtered set (inspired by Palantir Automate).

```typescript
defineWatcher({
  name: 'new_high_value_request',
  watch: {
    schema: 'purchase_request',
    filter: { amount: { gt: 50_000 }, status: 'submitted' },
  },
  trigger: {
    type: 'set_change',
    on: 'added',               // 'added' | 'removed' | 'modified'
  },
  effect: {
    action: 'send_notification',
    params: (ctx) => ({
      to: 'cfo@company.com',
      template: 'high_value_request',
      data: { id: ctx.record.id, amount: ctx.record.amount },
    }),
  },
})
```

## 4. Evaluation Strategy

Watchers need an evaluation mechanism. Two modes:

### 4.1 Post-Action Evaluation (reactive)

After any Action that modifies a watched schema, evaluate relevant watchers:

```
Action executed on schema X
  → Find watchers where watch.schema == X
  → Evaluate each watcher's condition
  → If condition met → execute effect
```

This is lightweight and immediate, but only catches changes from Actions (not direct DB edits).

**Implementation:** Hook into ActionExecutor's post-action phase (after EventHandler dispatch).

### 4.2 Scheduled Evaluation (polling)

For staleness and cron-based watchers, a background worker evaluates conditions periodically:

```
WatcherWorker runs every minute
  → Find watchers with type='staleness' or type='schedule'
  → Check if evaluation is due (cron match or staleness interval)
  → Execute query against DataProvider
  → If condition met → execute effect
```

**Implementation:** Runs alongside OutboxWorker. Uses the same DataProvider for queries.

### 4.3 Hybrid (recommended)

Use both: post-action for threshold/set_change watchers; scheduled for staleness/schedule watchers.

## 5. Debounce & Deduplication

Watchers must not fire repeatedly for the same condition:

| Strategy | Behavior |
|----------|----------|
| `once_until_reset` | Fire once when condition becomes true. Don't fire again until condition becomes false and then true again. |
| `once_per_record` | Fire once per record that matches. Track fired record IDs. |
| `cooldown` | Fire at most once per `cooldownPeriod` (e.g., `'1h'`). |

State tracking stored in a system table: `_linchkit_watcher_state`.

```typescript
// System table
_linchkit_watcher_state: {
  watcher_name: string        // watcher identifier
  group_key: string           // groupBy value or record ID
  last_fired_at: timestamp
  condition_met: boolean      // current condition state
  tenant_id: string
}
```

## 6. WatcherDefinition Full Structure

```typescript
defineWatcher({
  name: string,
  label: string,
  description?: string,

  watch: {
    schema: string,
    filter?: DeclarativeCondition,
    aggregate?: {
      field: string,
      op: 'sum' | 'count' | 'avg' | 'min' | 'max',
      groupBy?: string,        // group results by this field
    },
  },

  trigger: {
    type: 'threshold' | 'staleness' | 'schedule' | 'set_change',

    // For threshold:
    field?: string,                          // field to compare (individual record)
    condition?: ComparisonCondition,          // { gt, lt, eq, gte, lte }

    // For staleness:
    // field: timestamp field to check
    // threshold: duration string ('48h', '7d')

    // For schedule:
    cron?: string,
    // condition: optional — only fire if condition also met

    // For set_change:
    on?: 'added' | 'removed' | 'modified',

    // Debounce
    debounce?: 'once_until_reset' | 'once_per_record' | 'cooldown',
    cooldownPeriod?: string,     // for cooldown strategy
  },

  effect: {
    action: string,
    params: Record<string, unknown> | ((ctx: WatcherContext) => Record<string, unknown>),
  },

  // Restrictions
  enabled?: boolean,           // default: true
  tenantScoped?: boolean,      // default: true (evaluate per tenant)
})
```

## 7. Relation to Existing Concepts

| Concept | Role | Difference from Watcher |
|---------|------|------------------------|
| **Rule** | Pre-action constraint | Rules block/modify a specific Action. Watchers observe aggregate data state. |
| **EventHandler** | Post-event reaction | Handlers react to a single event. Watchers react to cumulative data conditions. |
| **Flow** | Multi-step orchestration | Flows orchestrate sequences. Watchers are single-trigger automations. |

**Mental model:**
- Rule = "should this action be allowed?"
- EventHandler = "this action happened, now do X"
- Watcher = "the data has reached state Y, do Z"

## 8. Security

- Watcher effects execute through the normal Action pipeline (CommandLayer, permission checks)
- Watcher effects run as `system` actor (not as the user who triggered the data change)
- System actor permissions must be explicitly granted per watcher
- `tenant_id` scoping is mandatory — watchers evaluate per tenant

## 9. What NOT to do

- **Do NOT evaluate watchers synchronously in the Action transaction** — evaluation is post-action or scheduled. Never block the action pipeline.
- **Do NOT replace EventHandlers** — watchers complement, not replace. Use EventHandlers for direct reactions to specific events. Use Watchers for aggregate/condition-based automation.
- **Do NOT build a full CEP (Complex Event Processing) engine** — keep it simple. If requirements grow beyond threshold/staleness/schedule/set_change, consider a dedicated CEP system.

## 10. Milestone

### M3
- `defineWatcher()` type definition + `WatcherRegistry`
- Threshold watcher (post-action evaluation)
- Staleness watcher (scheduled evaluation)
- `_linchkit_watcher_state` system table
- Debounce: `once_until_reset`, `once_per_record`

### M4
- Set change watcher
- Schedule (cron) watcher
- Watcher management UI (enable/disable, view state, history)
- `cooldown` debounce strategy
