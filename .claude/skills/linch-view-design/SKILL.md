---
name: "linch:view-design"
description: "View design: types, defineView pattern, fields, sort, filters"
---

# View Design

## View Types
| Type | Description |
|------|-------------|
| `list` | Table/list view |
| `form` | Create/edit form |
| `kanban` | Kanban board (requires enum/state field) |
| `detail` | Read-only detail view |

## Pattern
```ts
defineView({
  name: 'order_list',
  entity: 'order',
  type: 'list',
  fields: [
    { field: 'order_number', width: 120 },
    { field: 'customer', widget: 'ref-link' },
    { field: 'status', widget: 'badge' },
    { field: 'total', widget: 'currency' },
  ],
  defaultSort: { field: 'created_at', direction: 'desc' },
  filters: [
    { field: 'status', operator: 'eq' },
    { field: 'created_at', operator: 'between' },
  ],
})
```
