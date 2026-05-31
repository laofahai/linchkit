---
name: "linch:capability-dev"
description: "Full capability development workflow from discovery to quality gates"
---

# Capability Development Workflow

## Steps

1. **Discovery** — Understand the domain. Identify entities, actions, rules, states, and views needed.
2. **Design** — Define the data structures first. Use `defineEntity()` for each model, `defineRelation()` for connections.
3. **Validate** — Run `linch validate` to check definitions against the meta-model.
4. **Implement** — Write action handlers, rule effects, and event handlers.
5. **Test** — Write tests using `bun test`. Cover entity CRUD, action execution, rule triggering, and state transitions.
6. **Quality Gates** — All four must pass:
   - `linch validate`
   - `bun run check`
   - `bun run typecheck`
   - `bun run test` (the batched runner; a bare `bun test` crashes mid-run and skips all addons tests)

## MCP Tools

Use the LinchKit MCP server for validation and introspection:
- `linch validate` — Validate all capability definitions
- `linch mcp-dev` — Start MCP server for AI tool integration

## Capability Structure

```
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
```
