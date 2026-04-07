---
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
Use the `linchkit_list_capabilities` MCP tool to retrieve the registry of available capabilities.
Match the user's domain needs against what is already published.

### 3. Recommend & Install Capabilities
Present a short list of relevant capabilities with a one-line explanation each.
After the user confirms, install them:
```bash
linch install <cap-name>
```
Repeat for each selected capability.

### 4. Design Entities
Invoke the **linch:entity-design** skill to guide entity creation.
- Use `defineEntity()` for each data model
- Follow snake_case naming (singular nouns)
- Do NOT define system fields — they are auto-managed

### 5. Design Actions
Invoke the **linch:action-design** skill to define write operations.
- Use verb_noun naming: `create_order`, `approve_request`
- Every mutation flows through Actions

### 6. Design Rules & State (if needed)
If the domain has validation rules, approval flows, or stateful lifecycles:
- Invoke **linch:rule-design** for declarative rules
- Invoke **linch:state-design** for finite state machines

### 7. Verify with Dev Server
Start the development server and confirm everything loads:
```bash
linch dev
```

### 8. Run Quality Gates
All four checks MUST pass:
```bash
linch validate
bun run check
bun run typecheck
bun test
```

## Guidelines

- **Interactive** — One question at a time. Wait for user confirmation before moving on.
- **MCP introspection** — Use LinchKit MCP tools (`linchkit_list_capabilities`, `linchkit_describe_entity`, etc.) to inspect the project state.
- **Naming conventions** — snake_case for entities, fields, and actions. Singular nouns for entities. verb_noun for actions.
- **Third-party APIs** — When using any third-party library API, verify current usage via `context7` MCP tools (`resolve-library-id` then `query-docs`). Do NOT rely on training data.
- **File size** — Keep every file under 500 lines. Split by responsibility when approaching the limit.
- **No system fields** — Never define `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`, `updated_by`, or `_version`. They are auto-managed.
