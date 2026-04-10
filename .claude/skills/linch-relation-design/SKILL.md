---
name: "linch:relation-design"
description: "Relation design: cardinality types, defineRelation pattern, cascade rules"
---

# Relation Design

## Cardinality Types
| Type | Description |
|------|-------------|
| `many_to_one` | Many source records → one target |
| `one_to_many` | One source → many targets |
| `many_to_many` | Many-to-many via junction table |
| `one_to_one` | One-to-one |

## Pattern
```ts
defineRelation({
  name: 'order_customer',
  from: 'order',
  to: 'customer',
  cardinality: 'many_to_one',
  fromName: 'customer',
  toName: 'orders',
  cascade: 'none',
})
```

## Cascade Rules
| Rule | Description |
|------|-------------|
| `none` | Do not cascade deletes or nullification |
| `delete` | Delete related records |
| `nullify` | Set the relation to null when supported |
