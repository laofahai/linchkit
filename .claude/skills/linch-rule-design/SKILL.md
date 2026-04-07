---
name: "linch:rule-design"
description: "Rule design: defineRule pattern, effect types, trigger types"
---

# Rule Design

## Pattern
```ts
defineRule({
  name: 'validate_positive_total',
  entity: 'order',
  trigger: { on: 'before_action', actions: ['create_order'] },
  condition: { field: 'total', operator: 'gt', value: 0 },
  effect: { type: 'block', message: 'Total must be positive' },
})
```

## Trigger Types
| Trigger | When |
|---------|------|
| `before_action` | Before an action executes |
| `after_action` | After an action completes |
| `on_event` | When a domain event fires |
| `schedule` | On a cron schedule |

## Effect Types
| Effect | Description |
|--------|-------------|
| `block` | Prevent the action, return error message |
| `enrich` | Modify the input data before action |
| `notify` | Send a notification |
| `custom` | Run custom logic |
