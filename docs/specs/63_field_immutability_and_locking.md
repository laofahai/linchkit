# Field Immutability & Locking

> Tracking milestones:
> - `M5: Platform Maturity & AI Evolution`
>
> Related issues:
> - GitHub Issue `#126` — Field immutability & locking enforcement
>
> Execution source of truth: GitHub milestones and issues.

## 1. Problem Statement

LinchKit has `immutable: true` in `FieldConstraints` but zero enforcement. No engine, no validation, no UI integration. Additionally, there is no mechanism for **conditional field locking** — locking fields based on entity state or domain conditions.

Both are critical for data integrity in business applications:
- **Immutable fields:** Document numbers, financial codes, audit references — must never change after creation
- **Locked fields:** Amount locked after approval, supplier locked after submission — state-driven protection

Reference implementation: luyun-odoo's `ImmutableMixin` + `LockMixin` (battle-tested in financial systems).

## 2. Two Concepts

### 2.1 Immutable Fields

A field marked `immutable: true` **cannot be modified after first assignment**. Period.

```typescript
defineEntity({
  name: 'purchase_request',
  fields: {
    code: { type: 'string', immutable: true },  // Never changes after set
  }
})
```

**Semantics:**
- First write (create or first non-null assignment): allowed
- Any subsequent write that changes the value: blocked
- Setting the same value again: allowed (no-op)
- Setting to `null` after having a value: blocked

### 2.2 Locked Fields (Conditional)

A field with `lockWhen` is **conditionally readonly** based on entity state or a domain expression.

```typescript
defineEntity({
  name: 'purchase_request',
  fields: {
    amount: {
      type: 'decimal',
      lockWhen: { state: ['submitted', 'approved'] },
    },
    supplier: {
      type: 'ref',
      lockWhen: { state: { not: 'draft' } },  // Lock when NOT draft
    },
  }
})
```

**`__all__` shorthand** — lock all non-system fields at a given state:

```typescript
defineEntity({
  name: 'invoice',
  lockAllWhen: { state: 'posted' },
  lockAllowFields: ['notes', 'tags'],  // Exempt from __all__ lock
  fields: { ... }
})
```

## 3. Lock Condition Syntax

```typescript
interface LockCondition {
  /** Lock when entity is in any of these states */
  state?: string | string[] | { not: string | string[] };
  /** Lock when a field-based domain matches (future extension) */
  domain?: Array<[string, string, unknown]>;
}
```

State-based locking covers 90%+ of real-world cases. Domain-based locking is reserved for future complex scenarios.

## 4. Architecture — Core vs Capability

Following the permission pattern (core defines slot, capability provides advanced features):

### 4.1 Core (packages/core)

**Type definitions:**

```typescript
// Already exists in FieldConstraints:
immutable?: boolean;

// New additions to BaseFieldDefinition:
lockWhen?: LockCondition;

// New additions to EntityDefinition:
lockAllWhen?: LockCondition;
lockAllowFields?: string[];
```

**Engine enforcement — Action Engine pipeline:**

```
Input validation
  → Permission check
  → **Field lock check** ← NEW STEP
  → Pre-validation rules
  → State transition
  → Data write
```

The lock check runs on every **update** action:

```typescript
function checkFieldLocks(opts: {
  entity: EntityDefinition;
  existingRecord: Record<string, unknown>;
  input: Record<string, unknown>;
}): FieldLockViolation[] {
  const violations: FieldLockViolation[] = [];

  for (const [fieldName, newValue] of Object.entries(opts.input)) {
    const field = opts.entity.fields[fieldName];
    if (!field) continue;

    // 1. Immutable check
    if (field.immutable) {
      const existingValue = opts.existingRecord[fieldName];
      if (existingValue != null && newValue !== existingValue) {
        violations.push({
          field: fieldName,
          type: 'immutable',
          message: `Field '${fieldName}' is immutable and cannot be modified`,
        });
      }
    }

    // 2. Lock condition check
    const lockCondition = field.lockWhen ?? (opts.entity.lockAllowFields?.includes(fieldName) ? undefined : opts.entity.lockAllWhen);
    if (lockCondition) {
      if (matchesLockCondition(opts.existingRecord, lockCondition)) {
        violations.push({
          field: fieldName,
          type: 'locked',
          condition: lockCondition,
          message: `Field '${fieldName}' is locked in current state`,
        });
      }
    }
  }

  return violations;
}
```

**Error type:**

```typescript
// New error codes in errors.ts (following lowercase domain.category.specific format)
FIELD_LOCKED = 'validation.field.locked'
FIELD_IMMUTABLE = 'validation.field.immutable'
```

**Return format** — same as validation errors, with field-level detail:

```json
{
  "status": "failed",
  "error": {
    "code": "validation.field.locked",
    "message": "Cannot modify locked fields",
    "details": [
      { "field": "amount", "type": "locked", "message": "Field 'amount' is locked in state 'submitted'" }
    ]
  }
}
```

### 4.2 Capability: cap-lock (addons/lock/)

Advanced features that are NOT needed by every project:

| Feature | Description |
|---------|-------------|
| **Shadow mode** | Log lock violations but don't block — for rollout observation |
| **Two-step confirmation** | SOFT_LOCK: allow modification after explicit double-confirmation |
| **Bypass groups** | Certain actor groups can override locks (e.g., admin, finance_manager) |
| **Tolerance period** | New records can be freely modified within N minutes of creation |
| **Audit trail** | Log all lock violations and forced modifications to execution log |
| **Notification** | Notify stakeholders when locked fields are force-modified |
| **UI lock indicator** | Visual lock icon on locked fields, tooltip explaining why |

**cap-lock extends core's lock check** via a hook/slot mechanism:

```typescript
defineCapability({
  name: 'lock',
  hooks: {
    'field-lock-check': async (violations, context) => {
      if (shadowMode) {
        await logViolations(violations);
        return [];
      }
      if (context.actor.groups.some(g => bypassGroups.includes(g))) {
        await logBypass(violations, context.actor);
        return [];
      }
      const age = Date.now() - context.record.created_at;
      if (age < toleranceMs) {
        return [];
      }
      return violations;
    }
  }
})
```

## 5. UI Integration

### 5.1 Core UI (cap-adapter-ui)

The auto-form already respects `readonly` on fields. Lock state adds a **computed readonly**:

```typescript
const isLocked = useMemo(() => {
  if (field.immutable && existingValue != null) return true;
  if (field.lockWhen && matchesLockCondition(record, field.lockWhen)) return true;
  if (entity.lockAllWhen && !entity.lockAllowFields?.includes(fieldName)
      && matchesLockCondition(record, entity.lockAllWhen)) return true;
  return false;
}, [record, field]);

<FormField readonly={field.readonly || isLocked} />
```

### 5.2 cap-lock UI Extensions

- Lock icon on locked fields with tooltip: "Locked because state is 'submitted'"
- Confirmation dialog for SOFT_LOCK fields
- "Unlock" button for bypass-group users (with audit trail)

## 6. GraphQL & REST Behavior

Lock checks apply at the **Action Engine level**, so all transports (GraphQL mutations, REST `/api/actions`, MCP) automatically enforce them. No transport-level code needed.

The GraphQL introspection / entity metadata endpoint should expose lock conditions so clients can pre-compute locked state without trial-and-error:

```graphql
type FieldMeta {
  name: String!
  immutable: Boolean
  lockWhen: LockCondition
}
```

## 7. Interaction with Other Features

### 7.1 State Machine

Lock conditions reference state values. When a state transition occurs, the locked field set changes automatically.

```
draft → submitted:  amount, supplier become locked
submitted → draft:  amount, supplier become unlocked (returned to draft)
submitted → approved: remains locked
approved → done:    lockAllWhen activates, everything locked
```

### 7.2 AI Proposals

AI Proposals that modify locked fields should be:
1. **Flagged** in the Proposal review UI with lock violation warnings
2. **Allowed** if the Proposal is approved by a user with bypass permission
3. **Blocked** if auto-apply is enabled and no bypass permission exists

### 7.3 Overlay System

Overlays can override `lockWhen` conditions per tenant — e.g., a tenant may want stricter locking (lock amount even in draft) or relaxed locking (allow amount changes until approved).

### 7.4 Bulk Operations

Bulk update must check locks per-record (each record may be in a different state). Return per-record results:

```json
{
  "results": [
    { "id": "r1", "status": "succeeded" },
    { "id": "r2", "status": "failed", "error": { "code": "validation.field.locked" } }
  ]
}
```

## 8. Migration from Existing `readonly`

Current `readonly: true` means "field cannot be modified after creation" — this is semantically identical to `immutable: true`. Plan:

1. Keep `readonly` for backward compatibility (alias to `immutable` in engine)
2. Deprecate `readonly` on fields in favor of `immutable` (clearer semantics)
3. `readonly` in **view definitions** remains (UI-only display hint, no engine enforcement)

> **Deprecation notice:** Field-level `readonly: true` is deprecated. Use `immutable: true` for new schemas. The engine treats `readonly` as an alias of `immutable`, but `readonly` will be removed in a future major version. In view definitions, `readonly` remains valid as a UI-only hint (no engine enforcement).

## 9. Test Strategy

| Test | Scope |
|------|-------|
| Immutable field blocks update | Core engine |
| Immutable field allows first assignment | Core engine |
| Immutable field allows same-value write | Core engine |
| lockWhen blocks update in matching state | Core engine |
| lockWhen allows update in non-matching state | Core engine |
| lockAllWhen locks all fields except allowlist | Core engine |
| Lock violation returns proper error format | Core engine |
| Shadow mode logs but doesn't block | cap-lock |
| Bypass group overrides lock | cap-lock |
| Tolerance period allows early modification | cap-lock |
| UI renders locked fields as readonly | cap-adapter-ui |
| Bulk update respects per-record lock state | Core engine |

## 10. Implementation Phases

### Phase 1 — Core enforcement (M5)
- Add `lockWhen`, `lockAllWhen`, `lockAllowFields` to type definitions
- Implement `checkFieldLocks()` in Action Engine pipeline
- Enforce existing `immutable` flag (currently unenforced)
- Error types and response format
- Core tests

### Phase 2 — UI integration (M5)
- Auto-form respects lock state (computed readonly)
- Lock metadata in GraphQL field introspection
- Bulk edit respects per-record locks

### Phase 3 — cap-lock capability (M6/M7)
- Shadow mode
- Two-step confirmation
- Bypass groups
- Tolerance period
- Audit trail integration
- Lock indicator UI
