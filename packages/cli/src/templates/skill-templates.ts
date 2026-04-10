/**
 * LinchKit skill file definitions for AI tool configuration
 */

import { engineDevSkillContent, workflowSkillContent } from "./workflow-skill-templates.js";

/** A single skill file definition */
export interface SkillDefinition {
  /** Used as directory name for Claude Code (.claude/skills/<slug>/SKILL.md) */
  slug: string;
  /** Used as filename for Cursor/Trae rules (<slug>.md) */
  filename: string;
  content: string;
}

/** Returns the set of LinchKit skill files for AI tool configuration */
export function linchkitSkills(): SkillDefinition[] {
  return [
    {
      slug: "linch-workflow",
      filename: "workflow.md",
      content: workflowSkillContent(),
    },
    {
      slug: "linch-engine-dev",
      filename: "engine-dev.md",
      content: engineDevSkillContent(),
    },
    {
      slug: "linch-capability-dev",
      filename: "capability-dev.md",
      content: capabilityDevSkillContent(),
    },
    {
      slug: "linch-entity-design",
      filename: "entity-design.md",
      content: entityDesignSkillContent(),
    },
    {
      slug: "linch-action-design",
      filename: "action-design.md",
      content: actionDesignSkillContent(),
    },
    {
      slug: "linch-rule-design",
      filename: "rule-design.md",
      content: ruleDesignSkillContent(),
    },
    {
      slug: "linch-state-design",
      filename: "state-design.md",
      content: stateDesignSkillContent(),
    },
    {
      slug: "linch-view-design",
      filename: "view-design.md",
      content: viewDesignSkillContent(),
    },
    {
      slug: "linch-relation-design",
      filename: "relation-design.md",
      content: relationDesignSkillContent(),
    },
    {
      slug: "linch-quality-gates",
      filename: "quality-gates.md",
      content: qualityGatesSkillContent(),
    },
    {
      slug: "linch-overlay-management",
      filename: "overlay-management.md",
      content: overlayManagementSkillContent(),
    },
    {
      slug: "linch-architecture",
      filename: "architecture.md",
      content: architectureSkillContent(),
    },
    {
      slug: "linch-bootstrap",
      filename: "bootstrap.md",
      content: bootstrapSkillContent(),
    },
  ];
}

function capabilityDevSkillContent(): string {
  return `---
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
`;
}

function entityDesignSkillContent(): string {
  return `---
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
| \`json\` | \`schema\`: Zod schema |
| \`state\` | state machine-backed field |

## System Fields (DO NOT define — auto-managed)
\`id\`, \`tenant_id\`, \`created_at\`, \`updated_at\`, \`created_by\`, \`updated_by\`, \`_version\`

## Inheritance
Use \`extends\` to inherit fields from a parent entity:
\`\`\`ts
defineEntity({ name: 'vip_customer', extends: 'customer', fields: { tier: { type: 'enum', ... } } })
\`\`\`

## Validation
Run \`linch validate\` to check entity definitions against the meta-model.
`;
}

function actionDesignSkillContent(): string {
  return `---
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
`;
}

function ruleDesignSkillContent(): string {
  return `---
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
`;
}

function stateDesignSkillContent(): string {
  return `---
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
`;
}

function viewDesignSkillContent(): string {
  return `---
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
`;
}

function relationDesignSkillContent(): string {
  return `---
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
  from: 'order',
  to: 'customer',
  cardinality: 'many_to_one',
  fromName: 'customer',
  toName: 'orders',
  cascade: 'none',
})
\`\`\`

## Cascade Rules
| Rule | Description |
|------|-------------|
| \`none\` | Do not cascade deletes or nullification |
| \`delete\` | Delete related records |
| \`nullify\` | Set the relation to null when supported |
`;
}

function qualityGatesSkillContent(): string {
  return `---
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

## 5. File Size Check
Single files MUST NOT exceed 500 lines. If a file is too large:
- Split by responsibility (e.g. \`discovery-tools.ts\`, \`validation-tools.ts\`)
- Extract shared helpers to a separate file
- Each file should have one clear responsibility

## Dependency API Verification
When using third-party library APIs, MUST verify current usage via context7 MCP tools:
1. \`resolve-library-id\` — find the library's context7 ID
2. \`query-docs\` — query the specific API pattern
Do NOT rely on training data — libraries change frequently.

## Commit Convention
Use Conventional Commits: \`feat:\`, \`fix:\`, \`refactor:\`, \`test:\`, \`docs:\`, \`chore:\`
`;
}

function overlayManagementSkillContent(): string {
  return `---
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
`;
}

function bootstrapSkillContent(): string {
  return `---
name: "linch:bootstrap"
description: "Guided project setup: discover needs, install capabilities, design entities/actions/rules"
---

# Bootstrap — AI-Guided Project Setup

Walk the user through setting up their LinchKit project step by step.
Ask **one question at a time** — do not dump all steps at once.

## Workflow

### 1. Discover Intent
Ask the user what kind of system they want to build.
Examples: e-commerce, CRM, project management, inventory, HR, ticketing.
Clarify the core domain and key workflows before proceeding.

### 2. Inspect Available Capabilities
Use the \`linchkit_list_capabilities\` MCP tool to retrieve the registry of available capabilities.
Match the user's domain needs against what is already published.

### 3. Recommend & Install Capabilities
Present a short list of relevant capabilities with a one-line explanation each.
After the user confirms, install them:
\`\`\`bash
linch install <cap-name>
\`\`\`
Repeat for each selected capability.

### 4. Design Entities
Invoke the **linch:entity-design** skill to guide entity creation.
- Use \`defineEntity()\` for each data model
- Follow snake_case naming (singular nouns)
- Do NOT define system fields — they are auto-managed

### 5. Design Actions
Invoke the **linch:action-design** skill to define write operations.
- Use verb_noun naming: \`create_order\`, \`approve_request\`
- Every mutation flows through Actions

### 6. Design Rules & State (if needed)
If the domain has validation rules, approval flows, or stateful lifecycles:
- Invoke **linch:rule-design** for declarative rules
- Invoke **linch:state-design** for finite state machines

### 7. Verify with Dev Server
Start the development server and confirm everything loads:
\`\`\`bash
linch dev
\`\`\`

### 8. Run Quality Gates
All four checks MUST pass:
\`\`\`bash
linch validate
bun run check
bun run typecheck
bun test
\`\`\`

## Guidelines

- **Interactive** — One question at a time. Wait for user confirmation before moving on.
- **MCP introspection** — Use LinchKit MCP tools (\`linchkit_list_capabilities\`, \`linchkit_describe_entity\`, etc.) to inspect the project state.
- **Naming conventions** — snake_case for entities, fields, and actions. Singular nouns for entities. verb_noun for actions.
- **Third-party APIs** — When using any third-party library API, verify current usage via \`context7\` MCP tools (\`resolve-library-id\` then \`query-docs\`). Do NOT rely on training data.
- **File size** — Keep every file under 500 lines. Split by responsibility when approaching the limit.
- **No system fields** — Never define \`id\`, \`tenant_id\`, \`created_at\`, \`updated_at\`, \`created_by\`, \`updated_by\`, or \`_version\`. They are auto-managed.
`;
}

function architectureSkillContent(): string {
  return `---
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

## File Size Rule
- Single file MUST NOT exceed 500 lines
- Split by responsibility when approaching the limit
- Shared helpers go to separate files
- \`index.ts\` only re-exports, no implementation logic
`;
}

// workflowSkillContent and engineDevSkillContent imported from ./workflow-skill-templates.ts
// (kept separate to stay under 500-line limit)
