---
name: "linch:architecture"
description: "Capability types, extension points, CommandLayer, core boundary, module rules"
---

# LinchKit Architecture

## Capability Types
| Type | Purpose | Example |
|------|---------|---------|
| `standard` | Business modules | CRM, inventory, invoicing |
| `adapter` | Protocol adapters | MCP, A2A, AG-UI |
| `bridge` | Cross-module connectors | Sync between capabilities |

## Extension Points
| Extension | Purpose |
|-----------|---------|
| `fieldTypes` | Custom field types (money, file) |
| `viewTypes` | Custom view types (map, gantt) |
| `ruleEffects` | Custom rule effects (send_sms) |
| `services` | Injectable services (storage, search) |
| `hooks` | Lifecycle hooks (system.start) |
| `middlewares` | CommandLayer slot middleware |
| `transports` | Protocol adapters |

## CommandLayer Pipeline
7-slot middleware: `pre → auth → exposure → permission → tenant → pre-action → post-action`

## Core Boundary Rule
Before adding to core, ask: "Without this, is a zero-capability LinchKit still AI-Native?"
- If yes → capability
- If no → core

## Module Boundaries
- `core` MUST NOT import from any other package
- `ui` MUST NOT import from `server`
- No circular dependencies
- Dependency flows one way: Capability → Core

## File Size Rule
- Single file MUST NOT exceed 500 lines
- Split by responsibility when approaching the limit
- Shared helpers go to separate files
- `index.ts` only re-exports, no implementation logic
