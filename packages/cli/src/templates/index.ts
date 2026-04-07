/**
 * Template functions for linch init scaffolding
 */

export function linchkitConfigTemplate(): string {
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

// --- AI tool configuration templates ---

export function mcpJsonTemplate(): string {
  return JSON.stringify(
    {
      mcpServers: {
        linchkit: {
          command: "bunx",
          args: ["linch", "mcp-dev", "--transport", "stdio"],
        },
      },
    },
    null,
    2,
  );
}

export function cursorRulesTemplate(projectName: string): string {
  return `# ${projectName} — Cursor Rules

Read AGENTS.md at the project root for full conventions, meta-model reference, and development workflow.

## Quick Reference
- Runtime: Bun (never Node/npx/npm)
- Language: TypeScript strict mode
- All definitions use \`defineXxx()\` functions
- Entity naming: snake_case
- Action naming: verb_noun
- Comments in English
- Run quality gates before committing: \`linch validate && bun run check && bun run typecheck && bun test\`
`;
}

export function codexMdTemplate(): string {
  return `# LinchKit Project

Read AGENTS.md at the project root for full conventions, meta-model reference, and development workflow.

Key rules:
- Runtime: Bun (never Node/npx/npm)
- TypeScript strict mode
- All definitions use \`defineXxx()\` functions
- Quality gates: \`linch validate && bun run check && bun run typecheck && bun test\`
`;
}

export function traeRulesTemplate(projectName: string): string {
  return `# ${projectName} — Trae Rules

Read AGENTS.md at the project root for full conventions, meta-model reference, and development workflow.

## Quick Reference
- Runtime: Bun (never Node/npx/npm)
- Language: TypeScript strict mode
- All definitions use \`defineXxx()\` functions
- Entity naming: snake_case
- Action naming: verb_noun
- Comments in English
- Run quality gates before committing: \`linch validate && bun run check && bun run typecheck && bun test\`
`;
}

export function copilotInstructionsTemplate(projectName: string): string {
  return `# ${projectName} — GitHub Copilot Instructions

This project uses LinchKit, an AI-Native Software Capability Runtime.

## Key Conventions
- **Runtime**: Bun — never use Node.js, npx, or npm
- **Language**: TypeScript strict mode, no \`any\` type
- **Definitions**: Use \`defineEntity()\`, \`defineAction()\`, \`defineRule()\`, \`defineState()\`, \`defineView()\`, \`defineRelation()\`
- **Entity naming**: snake_case (e.g. \`purchase_order\`)
- **Action naming**: verb_noun (e.g. \`approve_order\`)
- **Comments**: English
- **Capabilities**: Self-contained modules in \`addons/\` directory

## Quality Gates (must pass before commit)
1. \`linch validate\` — capability validation
2. \`bun run check\` — Biome lint + format
3. \`bun run typecheck\` — TypeScript strict check
4. \`bun test\` — all tests green

Read AGENTS.md for the full meta-model reference and development workflow.
`;
}

export function agentsUserMdTemplate(projectName: string): string {
  return `# ${projectName} — User Instructions

<!-- Add your project-specific instructions here. These supplement AGENTS.md. -->

## Project Description
<!-- Describe your project's domain and purpose -->

## Domain Glossary
<!-- Define key domain terms so AI tools understand your context -->

## Custom Conventions
<!-- Add any project-specific conventions beyond LinchKit defaults -->

## Notes
<!-- Any additional context for AI assistants -->
`;
}

/** A single skill file definition */
export interface SkillDefinition {
  filename: string;
  content: string;
}

/** Returns the set of LinchKit skill files for AI tool configuration */
export function linchkitSkills(): SkillDefinition[] {
  return [
    {
      filename: "capability-dev.md",
      content: `---
name: "linch:capability-dev"
description: "Full capability development workflow from discovery to quality gates"
---

# Capability Development Workflow

## Steps

1. **Discovery** — Understand the domain. Identify entities, actions, rules, states, and views needed.
2. **Design** — Define the data structures first. Use \`defineEntity()\` for each model, \`defineRelation()\` for connections.
3. **Validate** — Run \`linch validate\` to check definitions against the meta-model.
4. **Implement** — Write action handlers, rule effects, and event handlers.
5. **Test** — Write tests using \`bun test\`. Cover entity CRUD, action execution, rule triggering, and state transitions.
6. **Quality Gates** — All four must pass:
   - \`linch validate\`
   - \`bun run check\`
   - \`bun run typecheck\`
   - \`bun test\`

## MCP Tools

Use the LinchKit MCP server for validation and introspection:
- \`linch validate\` — Validate all capability definitions
- \`linch mcp-dev\` — Start MCP server for AI tool integration

## Capability Structure

\`\`\`
addons/my-capability/
  src/
    index.ts          # defineCapability() — registers all parts
    entities/          # defineEntity() definitions
    actions/           # defineAction() handlers
    rules/             # defineRule() definitions
    states/            # defineState() machines
    views/             # defineView() UI configs
  tests/
    *.test.ts
\`\`\`
`,
    },
    {
      filename: "entity-design.md",
      content: `---
name: "linch:entity-design"
description: "Entity design rules: naming, field types, system fields, inheritance"
---

# Entity Design

## Naming
- Use **snake_case**: \`purchase_order\`, \`customer_contact\`
- Singular nouns: \`order\` not \`orders\`

## Field Types

| Type | Options |
|------|---------|
| \`string\` | \`format\`: email, url, phone; \`maxLength\` |
| \`text\` | \`rich\`: true for HTML |
| \`number\` | \`min\`, \`max\`, \`precision\` |
| \`boolean\` | — |
| \`date\` | — |
| \`datetime\` | — |
| \`enum\` | \`options\`: [{ value, label }] |
| \`ref\` | \`target\`: entity name |
| \`json\` | \`schema\`: Zod schema |

## System Fields (DO NOT define — auto-managed)
\`id\`, \`tenant_id\`, \`created_at\`, \`updated_at\`, \`created_by\`, \`updated_by\`, \`_version\`

## Inheritance
Use \`extends\` to inherit fields from a parent entity:
\`\`\`ts
defineEntity({ name: 'vip_customer', extends: 'customer', fields: { tier: { type: 'enum', ... } } })
\`\`\`

## Validation
Run \`linch validate\` to check entity definitions against the meta-model.
`,
    },
    {
      filename: "action-design.md",
      content: `---
name: "linch:action-design"
description: "Action design: naming, types, input/output, policy, state transitions"
---

# Action Design

## Naming
Use **verb_noun** format: \`create_order\`, \`approve_request\`, \`ship_package\`

## Action Types
| Type | Description |
|------|-------------|
| \`create\` | Insert a new record |
| \`update\` | Modify an existing record |
| \`delete\` | Remove a record (soft delete default) |
| \`custom\` | Custom business logic |

## Structure
\`\`\`ts
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
\`\`\`

## State Transitions
Actions can trigger state transitions. The state machine validates the transition is allowed.

## Validation
Run \`linch validate\` to check action definitions.
`,
    },
    {
      filename: "rule-design.md",
      content: `---
name: "linch:rule-design"
description: "Rule design: defineRule pattern, effect types, trigger types"
---

# Rule Design

## Pattern
\`\`\`ts
defineRule({
  name: 'validate_positive_total',
  entity: 'order',
  trigger: { on: 'before_action', actions: ['create_order'] },
  condition: { field: 'total', operator: 'gt', value: 0 },
  effect: { type: 'block', message: 'Total must be positive' },
})
\`\`\`

## Trigger Types
| Trigger | When |
|---------|------|
| \`before_action\` | Before an action executes |
| \`after_action\` | After an action completes |
| \`on_event\` | When a domain event fires |
| \`schedule\` | On a cron schedule |

## Effect Types
| Effect | Description |
|--------|-------------|
| \`block\` | Prevent the action, return error message |
| \`enrich\` | Modify the input data before action |
| \`notify\` | Send a notification |
| \`custom\` | Run custom logic |
`,
    },
    {
      filename: "state-design.md",
      content: `---
name: "linch:state-design"
description: "State machine: defineState pattern, transitions, final states"
---

# State Machine Design

## Pattern
\`\`\`ts
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
\`\`\`

## Rules
- Each entity can have one state machine
- \`initial\` defines the starting state
- \`final: true\` marks terminal states (no outgoing transitions)
- Transitions are triggered by actions — the action name must match a defined action
- Invalid transitions are automatically blocked by the engine
`,
    },
    {
      filename: "view-design.md",
      content: `---
name: "linch:view-design"
description: "View design: types, defineView pattern, fields, sort, filters"
---

# View Design

## View Types
| Type | Description |
|------|-------------|
| \`list\` | Table/list view |
| \`form\` | Create/edit form |
| \`kanban\` | Kanban board (requires enum/state field) |
| \`detail\` | Read-only detail view |

## Pattern
\`\`\`ts
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
\`\`\`
`,
    },
    {
      filename: "relation-design.md",
      content: `---
name: "linch:relation-design"
description: "Relation design: cardinality types, defineRelation pattern, cascade rules"
---

# Relation Design

## Cardinality Types
| Type | Description |
|------|-------------|
| \`many_to_one\` | Many source records → one target |
| \`one_to_many\` | One source → many targets |
| \`many_to_many\` | Many-to-many via junction table |
| \`one_to_one\` | One-to-one |

## Pattern
\`\`\`ts
defineRelation({
  name: 'order_customer',
  source: 'order',
  target: 'customer',
  cardinality: 'many_to_one',
  sourceField: 'customer_id',
  cascade: { onDelete: 'restrict' },
})
\`\`\`

## Cascade Rules
| Rule | Description |
|------|-------------|
| \`restrict\` | Prevent deletion if related records exist (default) |
| \`cascade\` | Delete related records |
| \`set_null\` | Set foreign key to null |
`,
    },
    {
      filename: "quality-gates.md",
      content: `---
name: "linch:quality-gates"
description: "Four mandatory quality checks before committing"
---

# Quality Gates

All four checks MUST pass before committing code:

## 1. Capability Validation
\`\`\`bash
linch validate
\`\`\`
Validates all \`defineXxx()\` definitions against the meta-model schema.

## 2. Lint & Format
\`\`\`bash
bun run check
\`\`\`
Runs Biome for linting and formatting. Fix issues with \`bun run check --fix\`.

## 3. Type Check
\`\`\`bash
bun run typecheck
\`\`\`
Runs \`tsc --noEmit\` in strict mode. No \`any\` types allowed.

## 4. Tests
\`\`\`bash
bun test
\`\`\`
All tests must pass. Write tests alongside implementation.

## Commit Convention
Use Conventional Commits: \`feat:\`, \`fix:\`, \`refactor:\`, \`test:\`, \`docs:\`, \`chore:\`
`,
    },
    {
      filename: "overlay-management.md",
      content: `---
name: "linch:overlay-management"
description: "Overlay management: what overlays can/can't do, CLI commands, promotion"
---

# Overlay Management

## What Are Overlays?
Overlays allow customizing entity definitions, views, and rules without modifying the original capability source code.

## What Overlays CAN Do
- Add new fields to existing entities
- Override view configurations (field order, visibility, widgets)
- Add new rules to existing entities
- Add new actions to existing entities

## What Overlays CANNOT Do
- Remove fields defined by the original capability
- Change field types
- Modify action handlers directly
- Break the meta-model contract

## CLI Commands
\`\`\`bash
linch overlay list                    # List all active overlays
linch overlay create <name>           # Create a new overlay
linch overlay promote <overlay-name>  # Promote overlay to permanent change
\`\`\`

## Promotion Workflow
1. Create overlay for experimental changes
2. Test in development
3. Promote to permanent capability change when validated
`,
    },
    {
      filename: "architecture.md",
      content: `---
name: "linch:architecture"
description: "Capability types, extension points, CommandLayer, core boundary, module rules"
---

# LinchKit Architecture

## Capability Types
| Type | Purpose | Example |
|------|---------|---------|
| \`standard\` | Business modules | CRM, inventory, invoicing |
| \`adapter\` | Protocol adapters | MCP, A2A, AG-UI |
| \`bridge\` | Cross-module connectors | Sync between capabilities |

## Extension Points
| Extension | Purpose |
|-----------|---------|
| \`fieldTypes\` | Custom field types (money, file) |
| \`viewTypes\` | Custom view types (map, gantt) |
| \`ruleEffects\` | Custom rule effects (send_sms) |
| \`services\` | Injectable services (storage, search) |
| \`hooks\` | Lifecycle hooks (system.start) |
| \`middlewares\` | CommandLayer slot middleware |
| \`transports\` | Protocol adapters |

## CommandLayer Pipeline
7-slot middleware: \`pre → auth → exposure → permission → tenant → pre-action → post-action\`

## Core Boundary Rule
Before adding to core, ask: "Without this, is a zero-capability LinchKit still AI-Native?"
- If yes → capability
- If no → core

## Module Boundaries
- \`core\` MUST NOT import from any other package
- \`ui\` MUST NOT import from \`server\`
- No circular dependencies
- Dependency flows one way: Capability → Core
`,
    },
  ];
}
