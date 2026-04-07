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
linch docs           # Generate documentation
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

Capabilities can register additional CLI commands via the `extensions.commands` extension point, which are automatically discovered from `linchkit.config.ts`.

## Links

- [Repository](https://github.com/laofahai/linchkit)
