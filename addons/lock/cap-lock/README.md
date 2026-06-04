# @linchkit/cap-lock

Advanced field-lock policy capability (Spec 63 Phase 3).

Layers four optional escape hatches on top of core's Phase 1 field-lock
enforcement, exposed through a single value-returning `field-lock-check`
interceptor:

| Knob | Default | Behavior |
|------|---------|----------|
| `shadowMode` | `false` | Audit-log every violation, then **allow** (rollout observation). |
| `bypassGroups` | `[]` | If `actor.groups` intersects this list, audit-log and **allow**. |
| `toleranceMs` | `0` | If a record is younger than `toleranceMs` (from `created_at`), audit-log and **allow**. `0` disables. |

Evaluated in that order; the first match suppresses the violations (returns
`[]` = allow). With no match the interceptor returns the violations
**unchanged** so core re-throws (fail-closed). With default config the
capability is a no-op over core.

## Usage

```ts
import { createCapLock } from "@linchkit/cap-lock";

const capLock = createCapLock({
  logger,
  config: {
    shadowMode: false,
    bypassGroups: ["admin", "finance_manager"],
    toleranceMs: 5 * 60 * 1000, // 5 minutes
  },
});
```

For the default-config form use the exported `capLock` definition directly.

## Audit trail

When violations are suppressed, a structured `logger.info` is emitted with
`{ capability: "lock", reason: "shadow" | "bypass" | "tolerance", entity,
actorId, fields }` (Spec 63 §4.2).

## Out of scope (separate follow-up PRs)

- §5.2 cap-lock UI extensions (lock icon / tooltip / unlock button)
- SOFT_LOCK two-step confirmation
- Notification integration
