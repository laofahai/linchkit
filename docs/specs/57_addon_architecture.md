# Spec 57: Addon Architecture

> OCA-inspired capability grouping, addon_path discovery, autoInstall, graphqlExtensions, and UI panel registry.

## 1. Overview

Replace the flat `capabilities/` directory with a grouped `addons/` structure inspired by Odoo Community Association (OCA).
Each **addon group** is a directory containing related capabilities that can be split into an independent Git repo.
Each **capability** remains the unit of installation and activation.

### Goals

- **Capability is the activation unit** — users enable individual capabilities, not addon groups
- **Addon group is the distribution unit** — co-located, co-versioned, future repo boundary
- **autoInstall** — UI/bridge capabilities auto-activate when all dependencies are met
- **graphqlExtensions** — capabilities declare GraphQL types/resolvers via extensions (no manual wiring)
- **UI panel registry** — capabilities register UI panels declaratively; adapter renders conditionally
- **Zero breaking changes** to `CapabilityDefinition` consumer API (additive only)

### Non-Goals

- Runtime plugin loading (dynamic import at runtime)
- Addon marketplace / hub (Spec 21b scope)
- Version compatibility matrix between addon groups

## 2. Directory Structure

```
packages/                              # Core infrastructure (never split)
  @linchkit/core/
  @linchkit/cli/
  @linchkit/devtools/

addons/                                # All capabilities, grouped
  adapter-server/                      # Addon group: HTTP/GraphQL server
    cap-adapter-server/                #   Package: @linchkit/cap-adapter-server

  adapter-ui-react/                    # Addon group: React UI shell
    cap-adapter-ui-react/              #   Package: @linchkit/cap-adapter-ui-react
      ui-kit/                          #   Nested: @linchkit/ui-kit

  adapter-mcp/                         # Addon group: MCP transport
    cap-adapter-mcp/                   #   Package: @linchkit/cap-adapter-mcp

  chatter/                             # Addon group: record timeline
    cap-chatter/                       #   Backend: service, graphql, events
    cap-ui-react-chatter/              #   React UI: ChatterPanel

  auth/                                # Addon group: authentication
    cap-auth/                          #   Core auth (JWT, sessions)
    cap-auth-better-auth/              #   Better Auth provider
    cap-ui-react-auth/                 #   Login/register pages (future)

  permission/                          # Addon group: authorization
    cap-permission/                    #   RBAC permission engine

  ai-provider/                         # Addon group: AI provider SDK
    cap-ai-provider/                   #   AI SDK implementations

  flow-restate/                        # Addon group: flow engine
    cap-flow-restate/                  #   Restate durable execution

  migration/                           # Addon group: data migration
    cap-migration/                     #   Migration tooling

  purchase-demo/                       # Addon group: demo business module
    cap-purchase-demo/                 #   Purchase management scenario
```

### Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Backend capability | `cap-{feature}` | `cap-chatter` |
| React UI extension | `cap-ui-react-{feature}` | `cap-ui-react-chatter` |
| MCP extension | `cap-mcp-{feature}` | `cap-mcp-chatter` |
| Auth provider | `cap-auth-{provider}` | `cap-auth-better-auth` |
| Adapter | `cap-adapter-{protocol}` | `cap-adapter-server` |
| Addon group dir | `{feature}` | `chatter/` |

### Workspace Configuration

```json
{
  "workspaces": [
    "packages/*",
    "addons/*/cap-*",
    "addons/adapter-ui-react/cap-adapter-ui-react/ui-kit"
  ]
}
```

## 3. CapabilityDefinition Changes

Additive changes to `packages/core/src/types/capability.ts`:

```typescript
export interface CapabilityDefinition {
  // ...existing fields...

  /**
   * Addon group identifier. Capabilities with the same group are
   * co-located and can be split into an independent repository.
   * Purely organizational — runtime does not depend on it.
   */
  group?: string;

  /**
   * When true, this capability is automatically activated if ALL
   * entries in `dependencies` are present in the active capability set.
   * Analogous to Odoo's `auto_install` flag.
   *
   * Typical use: UI/bridge capabilities that should appear when
   * both the backend cap and the adapter are active.
   *
   * @default false
   */
  autoInstall?: boolean;
}
```

The existing `dependencies?: string[]` field is already present and used for hard dependency declaration.

## 4. CapabilityExtensions: graphqlExtensions

New extension point in `CapabilityExtensions`:

```typescript
export interface GraphQLExtensionRegistration {
  /** Query fields to merge into the root Query type */
  queryFields?: Record<string, import("graphql").GraphQLFieldConfig<unknown, unknown>>;
  /** Mutation fields to merge into the root Mutation type */
  mutationFields?: Record<string, import("graphql").GraphQLFieldConfig<unknown, unknown>>;
}

export interface CapabilityExtensions {
  // ...existing fields...

  /** GraphQL schema extensions — query/mutation fields merged into the main schema */
  graphqlExtensions?: GraphQLExtensionRegistration;
}
```

### How cap-adapter-server Consumes It

`collectCapabilityDefinitions()` collects all `graphqlExtensions` from capabilities.
`buildGraphQLSchema()` accepts `extraQueryFields` / `extraMutationFields` and merges them
into the root Query/Mutation types alongside the auto-generated CRUD fields.

## 5. LinchKitConfig: addons_path

```typescript
export interface LinchKitConfig {
  // ...existing fields...

  /**
   * Directories to scan for addon groups.
   * Each path is scanned for `cap-*/package.json` subdirectories.
   * Discovered capabilities are merged with explicitly listed capabilities.
   *
   * @example ["./addons", "./community-addons"]
   */
  addons_path?: string[];
}
```

### Discovery Flow

```
1. Load linchkit.config.ts
2. Read config.capabilities (explicit list — always takes priority)
3. For each path in config.addons_path:
   a. Scan {path}/*/cap-*/package.json
   b. Import each package's default export (CapabilityDefinition)
4. Merge: explicit capabilities + discovered capabilities (explicit wins on name collision)
5. Resolve autoInstall: find caps where autoInstall=true AND all dependencies are in active set
6. Topological sort by dependencies
7. Validate: no circular dependencies, no missing hard dependencies
8. Final active capability list
```

### autoInstall Resolution

```typescript
function resolveAutoInstall(
  explicit: CapabilityDefinition[],
  discovered: CapabilityDefinition[],
): CapabilityDefinition[] {
  const activeNames = new Set(explicit.map(c => c.name));
  const candidates = discovered.filter(c => c.autoInstall && !activeNames.has(c.name));

  let changed = true;
  while (changed) {
    changed = false;
    for (const cap of candidates) {
      if (activeNames.has(cap.name)) continue;
      const depsOk = (cap.dependencies ?? []).every(d => activeNames.has(d));
      if (depsOk) {
        activeNames.add(cap.name);
        changed = true;
      }
    }
  }

  return [...explicit, ...candidates.filter(c => activeNames.has(c.name))];
}
```

Fixed-point iteration: keeps resolving until no new capabilities are activated.
This handles transitive autoInstall chains (A autoInstalls B, B autoInstalls C).

## 6. UI Panel Registry

`cap-adapter-ui-react` provides a panel registration API.
UI extension capabilities (e.g., `cap-ui-react-chatter`) register panels at import time.

### Registry API

```typescript
// In cap-adapter-ui-react/src/lib/panel-registry.ts

export interface RecordPanelRegistration {
  /** ID — must be unique */
  id: string;
  /** Backend capability this panel depends on */
  capability: string;
  /** Mount slot (currently only "record-detail-tab") */
  slot: "record-detail-tab";
  /** Tab label (supports i18n key) */
  label: string;
  /** Icon name (Lucide) */
  icon?: string;
  /** Sort order (lower = earlier) */
  order?: number;
  /** Lazy-loaded React component */
  component: () => Promise<{ default: React.ComponentType<RecordPanelProps> }>;
}

export interface RecordPanelProps {
  schemaName: string;
  recordId: string;
  record?: Record<string, unknown>;
  fields?: Record<string, FieldDefinition>;
}

const registry: RecordPanelRegistration[] = [];

export function registerRecordPanel(panel: RecordPanelRegistration): void {
  registry.push(panel);
}

export function getRecordPanels(): RecordPanelRegistration[] {
  return registry.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
```

### Consumer Side (schema-form.tsx)

```typescript
const panels = getRecordPanels();
const appConfig = useAppConfig();
const activePanels = panels.filter(p =>
  appConfig.capabilities.includes(p.capability)
);

// Render tabs dynamically
{activePanels.map(panel => (
  <TabsTrigger key={panel.id} value={panel.id}>
    {t(panel.label)}
  </TabsTrigger>
))}
```

### cap-ui-react-chatter Registration

```typescript
// addons/chatter/cap-ui-react-chatter/src/index.ts
import { registerRecordPanel } from "@linchkit/cap-adapter-ui-react/panel-registry";

registerRecordPanel({
  id: "chatter",
  capability: "cap-chatter",
  slot: "record-detail-tab",
  label: "chatter.title",
  icon: "MessageSquare",
  order: 200,
  component: () => import("./chatter-panel"),
});
```

## 7. Addon Group Manifest (Optional)

Each addon group MAY have an `addon.ts` for metadata. Not required for functionality —
purely for tooling (future Hub, `linch addon list`, documentation generation).

```typescript
// addons/chatter/addon.ts
export default {
  name: "chatter",
  label: "Chatter & Timeline",
  description: "Record-level discussion, audit log, real-time updates",
  version: "0.1.0",
  author: "LinchKit",
  license: "MIT",
};
```

## 8. Migration from capabilities/ to addons/

### File Moves

| Source | Target |
|--------|--------|
| `capabilities/cap-adapter-server/` | `addons/adapter-server/cap-adapter-server/` |
| `capabilities/cap-adapter-ui-react/` | `addons/adapter-ui-react/cap-adapter-ui-react/` |
| `capabilities/cap-adapter-mcp/` | `addons/adapter-mcp/cap-adapter-mcp/` |
| `capabilities/cap-chatter/` | `addons/chatter/cap-chatter/` |
| `capabilities/cap-auth/` | `addons/auth/cap-auth/` |
| `capabilities/cap-auth-better-auth/` | `addons/auth/cap-auth-better-auth/` |
| `capabilities/cap-permission/` | `addons/permission/cap-permission/` |
| `capabilities/cap-ai-provider/` | `addons/ai-provider/cap-ai-provider/` |
| `capabilities/cap-flow-restate/` | `addons/flow-restate/cap-flow-restate/` |
| `capabilities/cap-migration/` | `addons/migration/cap-migration/` |
| `capabilities/cap-purchase-demo/` | `addons/purchase-demo/cap-purchase-demo/` |

### What Changes

1. Root `package.json` workspaces → `addons/*/cap-*`
2. `config/capabilities.ts` import paths → `@linchkit/cap-*` (unchanged, workspace resolves)
3. Any `tsconfig.json` path mappings referencing `capabilities/`
4. Vite config in cap-adapter-ui-react (proxy, aliases)
5. Biome config (include/exclude paths)
6. CI/CD scripts referencing `capabilities/`
7. CLAUDE.md documentation
8. The `capabilities/` directory is deleted

### What Does NOT Change

- npm package names (`@linchkit/cap-*`) — unchanged
- Import statements in source code — unchanged (workspace resolution handles paths)
- `CapabilityDefinition` shape — additive changes only
- Test commands — `bun test` still works from root

## 9. Cap-Chatter Integration (First Consumer)

### cap-chatter: Register graphqlExtensions

```typescript
// addons/chatter/cap-chatter/src/capability.ts
extensions: {
  services: [{ name: "chatter", factory: () => service }],
  graphqlExtensions: buildChatterGraphQLExtension({ service }),
}
```

### cap-ui-react-chatter: New Package

```
addons/chatter/cap-ui-react-chatter/
  package.json          → @linchkit/cap-ui-react-chatter
  src/
    index.ts            → registerRecordPanel() call
    chatter-panel.tsx   → moved from cap-adapter-ui-react
```

```typescript
// capability.ts
defineCapability({
  name: "cap-ui-react-chatter",
  label: "Chatter UI",
  group: "chatter",
  type: "standard",
  category: "system",
  version: "0.1.0",
  dependencies: ["cap-adapter-ui-react", "cap-chatter"],
  autoInstall: true,
});
```

### Version History Panel

`VersionHistoryPanel` stays in `cap-adapter-ui-react` — it depends only on core
execution logs (system table), not a separate capability. It's a built-in panel,
not a capability-provided panel. But it should also use the panel registry
for consistency. Register it as a built-in with `capability: "__builtin__"`.

## 10. OCA Comparison Table

| OCA Concept | LinchKit Equivalent |
|-------------|---------------------|
| Addon repository | Addon group directory (`addons/chatter/`) |
| `__manifest__.py` | `defineCapability()` in `capability.ts` |
| `depends` | `dependencies: string[]` |
| `auto_install` | `autoInstall: boolean` |
| `--addons-path` | `addons_path: string[]` in config |
| Installed Apps list | `capabilities: CapabilityDefinition[]` in config |
| Module Graph | Topological sort at startup |
| `static/src/js/` | `cap-ui-react-*` packages |
| OCA repo split | `group` field = repo boundary |
