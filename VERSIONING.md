# LinchKit Versioning & Release Compatibility

This document defines the versioning rules, breaking change policy, and compatibility
guarantees for all LinchKit packages. For the full deployment-level compatibility protocol
(blue-green, database migrations, rollback), see [Spec 38](./docs/specs/38_release_compatibility.md).

## Semantic Versioning

All LinchKit packages follow [Semantic Versioning 2.0.0](https://semver.org/):

- **MAJOR** (`X.y.z`) — Increments when introducing incompatible public API changes
- **MINOR** (`x.Y.z`) — Increments when adding backward-compatible functionality
- **PATCH** (`x.y.Z`) — Increments for backward-compatible bug fixes

### Pre-1.0 Rules

While packages are below 1.0.0, minor versions may contain breaking changes.
After 1.0.0, semver is strictly enforced.

### Linked Packages

Core infrastructure packages are version-linked (released together at the same version):

- `@linchkit/core`
- `@linchkit/cli`
- `@linchkit/devtools`

When any of these packages changes, all are released with the same version bump.

### Addon Packages

Addon (capability) packages are versioned independently. Each addon declares its
compatible core version range in `peerDependencies`.

## What Constitutes a Breaking Change

For packages at **1.0.0 and above**, the following changes require a **major** version bump (pre-1.0 packages may introduce these in minor releases per the pre-1.0 rules above):

### Type System

- Removing or renaming an exported type/interface
- Removing a required property from a type
- Changing a property type in a way that breaks existing consumers
- Making an optional property required
- Narrowing a union type (removing variants)

### API Surface

- Removing or renaming an exported function/class/constant
- Changing function parameter order or removing parameters
- Changing return type in an incompatible way
- Removing a method from a class
- Changing default behavior that consumers rely on

### Runtime Behavior

- Changing event names or payload structure (see Spec 38, section 5.3)
- Changing error codes or error class hierarchy
- Changing CommandLayer slot order or semantics
- Removing or renaming meta-model definition options (`defineEntity`, `defineAction`, etc.)
- Changing validation rules in a way that rejects previously valid input

### Database (for packages with persistence)

- See Spec 38, sections 3 and 4 for the full database change protocol
- Direct column removal, type change, or semantic change = **breaking**
- Must follow the expand-migrate-contract three-phase protocol

## What Is NOT a Breaking Change

The following changes are backward-compatible and require only a **minor** or **patch** bump:

### Additive Changes (minor)

- Adding new exported types, functions, or classes
- Adding new optional properties to existing types/interfaces
- Adding new optional parameters to functions (with defaults)
- Adding new event types
- Adding new fields to `defineEntity` options
- Widening a union type (adding variants)
- Adding new capability configuration options with defaults

### Internal Changes (patch)

- Refactoring internal implementation without changing public API
- Performance improvements
- Bug fixes that correct behavior to match documented intent
- Updating internal dependencies
- Improving error messages (without changing error codes)
- Adding or improving JSDoc comments

## Changeset Workflow

LinchKit uses [changesets](https://github.com/changesets/changesets) for version management.

### Adding a Changeset

After making changes to any publishable package, add a changeset:

```bash
bunx changeset
```

Select the affected packages, choose the bump type (major/minor/patch), and
write a human-readable summary of the change.

### Release Process

1. Changesets accumulate on `main` via PRs
2. The changesets bot creates a "Version Packages" PR
3. Merging that PR publishes all pending versions to npm

## Compatibility Matrix

### Core-Addon Compatibility

Each addon package declares its minimum compatible core version. The general rule:

| Core Version | Compatible Addon Versions |
|-------------|--------------------------|
| 0.1.x       | Addons built for 0.1.x   |
| 0.2.x       | Only addons built for 0.2.x (minor may be breaking) |
| 1.x.x       | Only addons built for ^1.0.0 |

**Rule**: Addons MUST declare `@linchkit/core` as a `peerDependency` with a
caret range (e.g., `"@linchkit/core": "^0.2.0"`). This ensures consumers get
clear warnings when versions are incompatible.

### Cross-Addon Compatibility

Addons that depend on other addons (e.g., `cap-chatter-ui` depends on `cap-chatter`)
must also use `peerDependencies` with caret ranges.

## Package List

### Core (linked versioning)

| Package | Description |
|---------|-------------|
| `@linchkit/core` | Types, engines, pipeline |
| `@linchkit/cli` | CLI launcher |
| `@linchkit/devtools` | Test utilities |

### Addons (independent versioning)

| Package | Description |
|---------|-------------|
| `@linchkit/cap-adapter-server` | Elysia + graphql-yoga + REST + CommandLayer server |
| `@linchkit/cap-adapter-ui` | React 19 UI adapter (Shadcn + TanStack) |
| `@linchkit/ui-kit` | Shared UI components (Shadcn) |
| `@linchkit/cap-adapter-mcp` | MCP transport adapter |
| `@linchkit/cap-mcp-ui` | MCP management UI |
| `@linchkit/cap-adapter-ag-ui` | AG-UI protocol adapter (agent↔frontend stream) |
| `@linchkit/cap-adapter-a2a` | A2A (agent-to-agent) protocol adapter |
| `@linchkit/cap-ai-provider` | AI provider capability (Anthropic, OpenAI, zhipu, …) |
| `@linchkit/cap-auth` | Authentication capability |
| `@linchkit/cap-auth-better-auth` | Better Auth provider |
| `@linchkit/cap-permission` | Permission capability (RBAC) |
| `@linchkit/cap-chatter` | Record timeline capability |
| `@linchkit/cap-chatter-ui` | Chatter UI components |
| `@linchkit/cap-audit-ui` | Audit-log UI |
| `@linchkit/cap-flow-restate` | Restate flow engine |
| `@linchkit/cap-dry-run` | Sandboxed execution dry-run runner |
| `@linchkit/cap-lock` | Capability/field lock policy |
| `@linchkit/cap-migration` | Database migration tooling |
| `@linchkit/cap-search-ui` | Search UI |
| `@linchkit/cap-theme` | Theming |
| `@linchkit/cap-keyboard-shortcuts` | Keyboard shortcuts |
| `@linchkit/cap-view-kanban` | Kanban view |
| `@linchkit/cap-view-calendar` | Calendar view |
| `@linchkit/cap-view-timeline` | Timeline view |

### Private (not published)

| Package | Description |
|---------|-------------|
| `@linchkit/cap-cache-redis` | Redis cache provider |
| `@linchkit/cap-file-storage` | File storage |
| `@linchkit/cap-notification` | Notification delivery |
| `@linchkit/cap-observability-otel` | OpenTelemetry traces/metrics |
| `@linchkit/cap-search` | Full-text search |
| `@linchkit/cap-vector-pgvector` | pgvector vector store |
| `@linchkit/cap-life-demo` | Life-system (Spec 55) demo |
| `@linchkit/cap-purchase-demo` | Purchase management demo |

## Migration Guide Template

When introducing a breaking change, include a migration guide in the changeset
summary and/or PR description using this format:

```markdown
## Migration Guide: [package]@[old] -> [new]

### Breaking Change

[One sentence describing what changed and why.]

### Before

[Code example showing the old API usage.]

### After

[Code example showing the new API usage.]

### Migration Steps

1. [Step-by-step instructions to update consuming code.]
2. [Include search patterns to find affected code, e.g., "Search for `oldFunctionName(`".]

### Timeline

- [old version] will receive security patches until [date].
- [new version] is available now.
```

## Release Cadence

- **Patch releases**: As needed for bug fixes (no fixed schedule)
- **Minor releases**: Roughly every 2-4 weeks as features accumulate
- **Major releases**: Only when breaking changes are necessary, with advance notice

All releases go through the changeset workflow. No manual version bumps.

## Deprecation Policy

Before removing public API:

1. Mark with `@deprecated` JSDoc tag including the replacement
2. Log a runtime deprecation warning on first use
3. Keep deprecated API for at least one minor release cycle
4. Remove in the next major release (X.0.0) with a migration guide

**Pre-1.0 exception:** Since minor versions may contain breaking changes before 1.0, deprecated APIs may be removed in the next 0.X.0 release with at least one 0.x.Y patch release of notice.
