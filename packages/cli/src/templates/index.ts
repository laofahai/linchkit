/**
 * Template functions for linch init scaffolding
 */

export function linchkitConfigTemplate(dbName: string): string {
  return `import { defineConfig } from '@linchkit/core'

export default defineConfig({
  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgres://localhost:5432/${dbName}',
  },

  // System capabilities
  system: {
    auth: true,
    permission: true,
    notification: false,
    audit: true,
  },

  // Server
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
})
`;
}

export function packageJsonTemplate(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.0.1",
      type: "module",
      scripts: {
        dev: "linch dev",
        test: "bun test",
      },
      dependencies: {
        "@linchkit/core": "^0.0.1",
        "@linchkit/cli": "^0.0.1",
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

## Project Overview

This is a LinchKit project — an AI-Native Software Capability Runtime.

## Tech Stack

- Runtime: Bun
- Framework: LinchKit
- Database: PostgreSQL
- ORM: Drizzle

## Commands

\`\`\`bash
bun install          # Install dependencies
linch dev            # Start development server
bun test             # Run tests
\`\`\`

## Project Structure

- \`linchkit.config.ts\` — Project configuration
- \`capabilities/\` — Capability definitions (Schema, Action, Rule, State, Event, View)
- \`migrations/\` — Database migrations
- \`tests/\` — Test files
`;
}

export function agentsMdTemplate(projectName: string): string {
  return `# ${projectName} — Agent Instructions

## Overview

This project uses LinchKit, an AI-Native Software Capability Runtime.

## Key Concepts

- **Capability**: A module that defines Schema, Actions, Rules, States, Events, and Views
- **Schema**: Data model definition using \`defineSchema()\`
- **Action**: Write operations using \`defineAction()\`
- **Rule**: Business rules using \`defineRule()\`
- **State**: State machine lifecycle using \`defineState()\`
- **View**: UI view definitions using \`defineView()\`

## Development Workflow

1. Define capabilities in \`capabilities/\` directory
2. Run \`linch dev\` to start the development server
3. The framework auto-detects changes and applies migrations

## Conventions

- Use \`defineXxx()\` functions for all definitions
- Keep capabilities self-contained
- Write tests in \`tests/\` directory
`;
}
