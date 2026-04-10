---
name: "linch:entity-design"
description: "Entity design rules: naming, field types, system fields, inheritance"
---

# Entity Design

## Naming
- Use **snake_case**: `purchase_order`, `customer_contact`
- Singular nouns: `order` not `orders`

## Field Types

| Type | Options |
|------|---------|
| `string` | `format`: email, url, phone; `maxLength` |
| `text` | `rich`: true for HTML |
| `number` | `min`, `max`, `precision` |
| `boolean` | — |
| `date` | — |
| `datetime` | — |
| `enum` | `options`: [{ value, label }] |
| `json` | `schema`: Zod schema |
| `state` | state machine-backed field |

## System Fields (DO NOT define — auto-managed)
`id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, `_version`

## Inheritance
Use `extends` to inherit fields from a parent entity:
```ts
defineEntity({ name: 'vip_customer', extends: 'customer', fields: { tier: { type: 'enum', ... } } })
```

## Validation
Run `linch validate` to check entity definitions against the meta-model.
