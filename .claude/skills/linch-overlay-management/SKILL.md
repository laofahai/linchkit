---
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
```bash
linch overlay list                    # List all active overlays
linch overlay create <name>           # Create a new overlay
linch overlay promote <overlay-name>  # Promote overlay to permanent change
```

## Promotion Workflow
1. Create overlay for experimental changes
2. Test in development
3. Promote to permanent capability change when validated
