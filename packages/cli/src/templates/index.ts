/**
 * Template functions for linch init scaffolding
 */

export function linchkitConfigTemplate(_dbName: string): string {
  return `import { defineConfig } from '@linchkit/core'

export default defineConfig({
  // Database (optional — omit for in-memory mode)
  database: {
    url: process.env.DATABASE_URL,
  },

  // Server
  server: {
    port: Number(process.env.PORT) || 3001,
    host: '0.0.0.0',
  },

  // Add capabilities here:
  // import { capAuth } from '@linchkit/cap-auth'
  // capabilities: [capAuth],
  capabilities: [],
})
`;
}

export function packageJsonTemplate(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "linch dev",
        "dev:server": "linch dev --server",
        test: "bun test",
        "db:generate": "linch db generate",
        "db:migrate": "linch db migrate",
      },
      dependencies: {
        "@linchkit/core": "^0.1.0",
        "@linchkit/cli": "^0.1.0",
        "@linchkit/cap-adapter-server": "^0.1.0",
      },
    },
    null,
    2,
  );
}

export function tsconfigTemplate(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["bun-types"],
      },
      include: ["**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  );
}

export function claudeMdTemplate(projectName: string): string {
  return `# ${projectName}

## Overview
LinchKit AI-Native Software Capability Runtime project.

## Tech Stack
- Runtime: Bun
- Framework: LinchKit
- Database: PostgreSQL (via Drizzle)
- Language: TypeScript (strict mode)

## Commands
\`\`\`bash
bun install          # Install dependencies
linch dev            # Start dev server (API on :3001)
bun test             # Run tests
linch db generate    # Generate DB migration from schema changes
linch db migrate     # Apply pending migrations
linch create capability <name>  # Scaffold a new capability
\`\`\`

## How to Build with LinchKit

### Define an Entity (data model)
\`\`\`ts
import { defineEntity } from '@linchkit/core'

export const customer = defineEntity({
  name: 'customer',
  label: 'Customer',
  fields: {
    name: { type: 'string', required: true },
    email: { type: 'string', format: 'email' },
    status: { type: 'enum', options: [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ]},
    company: { type: 'ref', target: 'company' },
  },
})
\`\`\`

### Define an Action (write operation)
\`\`\`ts
import { defineAction } from '@linchkit/core'

export const createCustomer = defineAction({
  name: 'create_customer',
  entity: 'customer',
  type: 'create',
  input: { name: { type: 'string', required: true }, email: { type: 'string' } },
  handler: async (input, ctx) => {
    return ctx.create('customer', input)
  },
})
\`\`\`

### Define a State Machine
\`\`\`ts
import { defineState } from '@linchkit/core'

export const orderState = defineState({
  name: 'order_status',
  entity: 'order',
  initial: 'draft',
  states: {
    draft: { transitions: [{ to: 'confirmed', action: 'confirm_order' }] },
    confirmed: { transitions: [{ to: 'shipped', action: 'ship_order' }] },
    shipped: { transitions: [{ to: 'delivered', action: 'deliver_order' }] },
    delivered: { final: true },
  },
})
\`\`\`

### Define a Capability (module)
\`\`\`ts
import { defineCapability } from '@linchkit/core'

export const myCapability = defineCapability({
  name: 'my-capability',
  label: 'My Capability',
  type: 'standard',
  entities: [customer],
  actions: [createCustomer],
  states: [orderState],
})
\`\`\`

### Register in config
\`\`\`ts
// linchkit.config.ts
import { myCapability } from './addons/my-capability/src'
export default defineConfig({
  capabilities: [myCapability],
})
\`\`\`

## Field Types
string, text, number, boolean, date, datetime, enum, ref, has_many, many_to_many, json

## Project Structure
- \`linchkit.config.ts\` — Configuration
- \`addons/\` — Capabilities (entities, actions, rules, states, views)
- \`drizzle/\` — Database migrations (auto-generated)
- \`tests/\` — Test files
`;
}

export function agentsMdTemplate(projectName: string): string {
  return `# ${projectName} — Agent Instructions

## Overview

This project uses LinchKit, an AI-Native Software Capability Runtime.
All business logic is defined declaratively using \`defineXxx()\` functions.

## Key Concepts

- **Capability**: A self-contained module grouping entities, actions, rules, states, events, and views
- **Entity**: Data model definition using \`defineEntity()\`
- **Action**: Write operations using \`defineAction()\`
- **Rule**: Business rules using \`defineRule()\`
- **State**: State machine lifecycle using \`defineState()\`
- **View**: UI view definitions using \`defineView()\`
- **Relation**: Relationships between entities using \`defineRelation()\`

## Development Workflow

1. Define capabilities in \`addons/\` directory
2. Register capabilities in \`linchkit.config.ts\`
3. Run \`linch dev\` to start the development server
4. The framework auto-detects changes and applies migrations

## Entity Field Types Reference

| Type | Description | Key Options |
|------|-------------|-------------|
| \`string\` | Short text | \`format\`: email, url, phone |
| \`text\` | Long text / rich text | \`rich\`: true for HTML |
| \`number\` | Numeric value | \`min\`, \`max\`, \`precision\` |
| \`boolean\` | True/false | — |
| \`date\` | Date only | — |
| \`datetime\` | Date + time | — |
| \`enum\` | Fixed options | \`options\`: [{ value, label }] |
| \`ref\` | Many-to-one reference | \`target\`: entity name |
| \`has_many\` | One-to-many | \`target\`, \`foreignKey\` |
| \`many_to_many\` | Many-to-many | \`target\`, \`through\` |
| \`json\` | Arbitrary JSON | \`schema\`: Zod schema |

## Action Types

| Type | Description |
|------|-------------|
| \`create\` | Insert a new record |
| \`update\` | Modify existing record |
| \`delete\` | Remove a record (soft delete by default) |
| \`custom\` | Custom business logic |

## State Machine Pattern

\`\`\`ts
import { defineState } from '@linchkit/core'

export const invoiceState = defineState({
  name: 'invoice_status',
  entity: 'invoice',
  initial: 'draft',
  states: {
    draft: {
      transitions: [
        { to: 'sent', action: 'send_invoice' },
        { to: 'cancelled', action: 'cancel_invoice' },
      ],
    },
    sent: {
      transitions: [
        { to: 'paid', action: 'mark_paid' },
        { to: 'overdue', action: 'mark_overdue' },
      ],
    },
    paid: { final: true },
    overdue: {
      transitions: [{ to: 'paid', action: 'mark_paid' }],
    },
    cancelled: { final: true },
  },
})
\`\`\`

## View Definition Pattern

\`\`\`ts
import { defineView } from '@linchkit/core'

export const customerListView = defineView({
  name: 'customer_list',
  entity: 'customer',
  type: 'list',
  fields: [
    { field: 'name', width: 200 },
    { field: 'email' },
    { field: 'status', widget: 'badge' },
    { field: 'created_at', label: 'Created' },
  ],
  defaultSort: { field: 'created_at', direction: 'desc' },
})
\`\`\`

## Rule Definition Pattern

\`\`\`ts
import { defineRule } from '@linchkit/core'

export const validateOrderTotal = defineRule({
  name: 'validate_order_total',
  entity: 'order',
  trigger: { on: 'before_action', actions: ['create_order', 'update_order'] },
  condition: { field: 'total', operator: 'gt', value: 0 },
  effect: { type: 'block', message: 'Order total must be positive' },
})
\`\`\`

## Relation Definition Pattern

\`\`\`ts
import { defineRelation } from '@linchkit/core'

export const orderCustomerRelation = defineRelation({
  name: 'order_customer',
  source: 'order',
  target: 'customer',
  cardinality: 'many_to_one',
  sourceField: 'customer_id',
})
\`\`\`

## Conventions

- Use \`defineXxx()\` functions for all definitions
- Keep capabilities self-contained in \`addons/<name>/\`
- Write tests in \`tests/\` directory
- Use Bun as runtime — never use Node.js / npx / npm
- Comments in English
`;
}

export function envExampleTemplate(): string {
  return `# Database (omit for in-memory mode)
# DATABASE_URL=postgres://user:password@localhost:5432/mydb

# Server
PORT=3001
`;
}

export function gitignoreTemplate(): string {
  return `node_modules/
dist/
.env
.linchkit/
drizzle/
*.log
`;
}
