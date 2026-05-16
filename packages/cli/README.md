# @linchkit/cli

CLI tool for LinchKit — project scaffolding, database management, capability management, and development utilities.

## Installation

```bash
bun add -g @linchkit/cli
```

## Usage

```bash
# Initialize a new project
linch init

# Start development server
linch dev

# Database management
linch db generate    # Generate migration SQL from schema changes
linch db migrate     # Apply pending migrations
linch db studio      # Open Drizzle Studio GUI

# Capability management
linch create         # Scaffold a new capability
linch install        # Install a capability
linch search         # Search capabilities
linch validate       # Run comprehensive validation

# Documentation and quality
linch docs           # Generate project-wide Markdown docs (Spec 25)
linch docs generate  # Markdown API doc (entity-centric, with mermaid)
linch docs openapi   # OpenAPI 3.0 spec for HTTP-exposed actions
linch docs validate  # Documentation completeness report
linch docs show <cap>  # Per-capability spec doc
linch docs search "<q>" # Cross-doc keyword search
linch check          # Run code quality checks
linch doctor         # Run project health checks
linch agents-md      # Generate AGENTS.md from project ontology

# MCP development
linch mcp-dev        # Start MCP server for AI coding tools

# Overlay management
linch overlay        # Manage runtime overlay fields

# Registry
linch registry       # Capability registry management
```

## `linch docs` (Spec 25)

`linch docs` walks the project's `OntologyRegistry` and emits a single
deterministic Markdown document covering every meta-model artifact:
entities, actions, rules, state machines, views, flows, and relations.
The output is auto-generated from `defineXxx()` calls, so it never
drifts from the code.

```bash
linch docs                       # writes ./docs/generated/README.md
linch docs --out path/to/api.md  # custom output path
linch docs --stdout              # write to stdout instead
linch docs --title "My API"      # override the document title
```

Subcommands cover advanced cases: `generate` for a per-entity Markdown
view (with mermaid diagrams), `openapi` for an OpenAPI 3.0 spec, `show`
for a single capability spec, `search` for keyword search, and
`validate` for documentation-completeness reporting (CI-friendly).

## Capability commands

Capabilities can register additional CLI commands via the `extensions.commands` extension point, which are automatically discovered from `linchkit.config.ts`.

## Links

- [Repository](https://github.com/laofahai/linchkit)
