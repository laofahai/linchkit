---
name: "linch:action-design"
description: "Action design: naming, types, input/output, policy, state transitions"
---

# Action Design

## Naming
Use **verb_noun** format: `create_order`, `approve_request`, `ship_package`

## Action Types
| Type | Description |
|------|-------------|
| `create` | Insert a new record |
| `update` | Modify an existing record |
| `delete` | Remove a record (soft delete default) |
| `custom` | Custom business logic |

## Structure
```ts
defineAction({
  name: 'approve_order',
  entity: 'order',
  type: 'update',
  input: { comment: { type: 'string' } },
  output: { approved: { type: 'boolean' } },
  policy: 'permission:approve_orders',
  handler: async (input, ctx) => {
    // Implementation
    return ctx.update('order', ctx.id, { status: 'approved' })
  },
})
```

## State Transitions
Actions can trigger state transitions. The state machine validates the transition is allowed.

## Validation
Run `linch validate` to check action definitions.
