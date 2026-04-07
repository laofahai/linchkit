# Contributing to LinchKit

Thank you for your interest in contributing to LinchKit! This guide will help you get started.

## Prerequisites

- [Bun](https://bun.sh/) (latest stable)
- [PostgreSQL](https://www.postgresql.org/) 15+
- [Docker](https://www.docker.com/) (optional, for Restate flow engine)

## Development Setup

```bash
# Clone the repository
git clone https://github.com/anthropic-ai/linchkit.git
cd linchkit

# Install dependencies
bun install

# Start PostgreSQL (if using Docker)
docker compose up -d

# Start development servers
bun run dev
```

### Available Commands

```bash
bun run dev:server    # Backend on :3001
bun run dev:ui        # Frontend on :3000 (proxies API to :3001)
bun test              # Run all tests
bun run check         # Biome lint + format
bun run typecheck     # TypeScript strict check
```

## Code Standards

### Tooling

- **Linter/Formatter:** [Biome](https://biomejs.dev/) (no ESLint, no Prettier)
- **TypeScript:** Strict mode, no `any` type
- **Package runner:** Always use `bunx`, never `npx`
- **Registry mirror:** `registry.npmmirror.com` (see `.bunfig.toml`)

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Entities, fields, actions | `snake_case` | `purchase_order`, `submit_request` |
| TypeScript variables, functions | `camelCase` | `handleSubmit`, `entityName` |
| Packages | `kebab-case` | `cap-adapter-server` |
| Actions | `verb_noun` | `approve_order`, `create_item` |

### File Guidelines

- Maximum **500 lines** per file. Split larger files into focused modules.
- Comments and documentation in **English**.
- No hardcoded secrets, no `eval()`, no `new Function()`.
- Sanitize all user inputs; use parameterized queries only.

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** from `main` (`feat/my-feature`, `fix/my-bug`)
3. **Write code** following the standards above
4. **Test** your changes
5. **Submit a PR** against `main`

### Quality Gates

All of these must pass before merge:

```bash
bun run check       # Biome lint + format
bun run typecheck   # TypeScript type checking
bun test            # Full test suite
```

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add entity inheritance support
fix: resolve N+1 query in relation resolver
docs: update API reference for CommandLayer
refactor: extract middleware pipeline from server
test: add coverage for AutomationEngine triggers
```

### Review Policy

- All review comments (CodeRabbit, Gemini, human) must be resolved before merge (enforced by GitHub).
- Verify third-party API usage with context7 before calling — training data may be stale.
- Apply good design patterns and algorithms, but do not over-engineer.

## Language

- **Code, comments, commit messages:** English
- **Issues, discussions, questions:** Chinese communication is welcome

## Architecture Overview

LinchKit follows a **Capability-Centric** architecture. Everything is a Capability (business, system, or protocol adapter). The core provides only engines, types, and pipeline. See `docs/specs/` for detailed specifications.

Key principles:
- **Minimal Core** — Core never changes for new features
- **Action as Sole Write Entry** — All mutations flow through Actions
- **Infinite Extensibility** — New protocols and features register via Capability extensions

## Questions?

Open an issue or start a discussion. We are happy to help!
