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
  source: 'order',
  target: 'customer',
  cardinality: 'many_to_one',
  sourceField: 'customer_id',
  cascade: { onDelete: 'restrict' },
})
```

## Cascade Rules
| Rule | Description |
|------|-------------|
| `restrict` | Prevent deletion if related records exist (default) |
| `cascade` | Delete related records |
| `set_null` | Set foreign key to null |
