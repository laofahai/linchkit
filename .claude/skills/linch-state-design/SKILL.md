---
name: "linch:state-design"
description: "State machine: defineState pattern, transitions, final states"
---

# State Machine Design

## Pattern
```ts
defineState({
  name: 'order_status',
  entity: 'order',
  initial: 'draft',
  states: {
    draft: {
      transitions: [
        { to: 'confirmed', action: 'confirm_order' },
        { to: 'cancelled', action: 'cancel_order' },
      ],
    },
    confirmed: {
      transitions: [{ to: 'shipped', action: 'ship_order' }],
    },
    shipped: {
      transitions: [{ to: 'delivered', action: 'deliver_order' }],
    },
    delivered: { final: true },
    cancelled: { final: true },
  },
})
```

## Rules
- Each entity can have one state machine
- `initial` defines the starting state
- `final: true` marks terminal states (no outgoing transitions)
- Transitions are triggered by actions — the action name must match a defined action
- Invalid transitions are automatically blocked by the engine
