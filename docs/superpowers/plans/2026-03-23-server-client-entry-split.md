# Server/Client Entry Point Split

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@linchkit/core` main entry browser-safe by moving all runtime engine exports to `@linchkit/core/server`.

**Architecture:** The main entry (`index.ts`) currently transitively pulls in `@restatedev/restate-sdk` and other Node-only deps via `engine/index.ts → flow/ → restate-client.ts`. Fix by: (1) splitting engine/index.ts into a pure barrel (no sibling re-exports), (2) moving all runtime exports from index.ts to server-entry.ts, (3) adding `export type` re-exports for engine interfaces to main entry (browser-safe), (4) updating ~20 consumer files to import runtime VALUE symbols from `@linchkit/core/server`.

**Tech Stack:** TypeScript, Bun

**Entry point design after this refactor:**

| Entry | Content | Browser-safe? |
|-------|---------|---------------|
| `@linchkit/core` | types + define + errors + config + `evaluateCondition` + `resolveField` + `generateZodSchema` + translatable utils | Yes |
| `@linchkit/core/server` | ALL runtime engines, registries, persistence, event, flow, observability, AI | No |
| `@linchkit/core/define` | subset of main (define functions + errors + types) | Yes |
| `@linchkit/core/types` | pure type re-exports | Yes |
| `@linchkit/core/config` | config registry + schemas | Yes |

**Symbols staying in main entry (browser-safe):**
- All `defineXxx` / `extendXxx` / `overrideXxx` functions (from `./define`)
- All error classes (from `./errors`)
- All types (`export type *` from `./types`)
- Config: `ConfigRegistry`, `defineConfigSchema`, `serverConfig`, `databaseConfig`, `queueConfig`, `securityConfig`
- `evaluateCondition`, `resolveField` (pure logic, no deps)
- `generateZodSchema` (depends only on `zod`)
- Translatable utils: `resolveTranslatableValue`, `normalizeTranslatableValue`, `wrapTranslatableValue`, `mergeTranslatableValue`, `getTranslatableFields`, `resolveTranslatableRow`, `normalizeTranslatableRow`
- `resolveEnvVars` utility
- `capabilityCategoryEnum`, `capabilityTypeEnum`, `capabilityMetadataSchema`, `validateCapabilityMetadata`, `ERROR_STATUS_MAP`

**Symbols moving to server-entry.ts:**
- Engine: `ActionRegistry`, `createActionExecutor`, `createCommandLayer`, `ExposureError`, `PipelineError`
- Approval: `createApprovalEngine`, `createApprovalVerifier`, `InMemoryApprovalStore`
- State: `createStateMachine`, `canTransition`, `transition`, `getAvailableActions`
- Rule: `evaluateRules`
- Validation: `validatePhase1`, `validateProposal`
- Permission: `PermissionRegistry`, `checkActionPermission`, `resolveConditionVariables`, `resolveDataAccess`
- Proposal: `createProposalEngine`, `ProposalEngine`, `bumpVersion`, `createProposalGenerator`
- Schema registry: `SchemaRegistry`, `createSchemaRegistry`
- Event: `createEventBus`, `EventBus`, `EventHandlerRegistry`
- Observability: `consoleLogger`, `InMemoryExecutionLogger`, `getCurrentTrace`, `getTraceDepth`, `withTrace`
- AI: `createAIService`, `createNoopAIService`, `defaultAIConfig`, `resolveModel`
- Flow: all flow exports (already partially there conceptually)

---

### Task 1: Restructure `engine/index.ts` — remove sibling re-exports

**Files:**
- Modify: `packages/core/src/engine/index.ts`

- [ ] **Step 1: Remove all sibling directory re-exports from engine/index.ts**

Keep only the local business engine exports (lines 9-87 of current file). Remove the entire `// === Re-exports from sibling directories ===` section (lines 89-134) which re-exports from `../ai`, `../observability`, `../event`, `../schema`, `../flow`.

After edit, `engine/index.ts` should only export from local files:
- `./action-engine`
- `./approval-engine`
- `./command-layer`
- `./condition-evaluator`
- `./permission-engine`
- `./proposal-engine`
- `./proposal-generator`
- `./rule-engine`
- `./state-machine`
- `./validation-engine`

- [ ] **Step 2: Run typecheck to see what breaks**

Run: `bun run typecheck 2>&1 | head -50`
Expected: Errors in `index.ts` (main entry) because it was importing some symbols via `./engine` that now come from sibling dirs directly. This is expected — we fix it in Task 2.

---

### Task 2: Rewrite main `index.ts` — browser-safe only

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Rewrite index.ts to export only browser-safe symbols**

Replace the entire file with:

```typescript
/**
 * @linchkit/core — Core runtime
 *
 * Browser-safe entry point: types, define functions, errors, config,
 * and pure-logic utilities (condition evaluator, Zod generator, translatable).
 *
 * For runtime engines, database, event bus, flow — use:
 *   import { ... } from "@linchkit/core/server"
 */

export const VERSION = "0.0.1";

// Config center
export type { ConfigSchemaRef } from "./config";
export {
  ConfigRegistry,
  databaseConfig,
  defineConfigSchema,
  queueConfig,
  securityConfig,
  serverConfig,
} from "./config";

// Define function exports
export {
  defineAction,
  defineCapability,
  defineConfig,
  defineDataAccess,
  defineEvent,
  defineEventHandler,
  definePermissionGroup,
  defineRule,
  defineSchema,
  defineState,
  defineView,
  disableRule,
  extendPermissionGroup,
  extendSchema,
  extendState,
  extendView,
  overrideAction,
  overrideRule,
  overrideSchema,
} from "./define";

// Error classes
export {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConflictError,
  LinchKitError,
  NotFoundError,
  SystemError,
  ValidationError,
} from "./errors";

// Pure-logic utilities (no server deps)
export { type ConditionContext, evaluateCondition, resolveField } from "./engine/condition-evaluator";
export { generateZodSchema, type ZodGeneratorOptions } from "./schema/schema-to-zod";
export {
  getTranslatableFields,
  mergeTranslatableValue,
  normalizeTranslatableRow,
  normalizeTranslatableValue,
  resolveTranslatableRow,
  resolveTranslatableValue,
  type TranslatableValue,
  wrapTranslatableValue,
} from "./schema/translatable";

// Type exports
export type * from "./types";
// Non-type exports from types
export {
  capabilityCategoryEnum,
  capabilityMetadataSchema,
  capabilityTypeEnum,
  ERROR_STATUS_MAP,
  validateCapabilityMetadata,
} from "./types";
export type { Logger } from "./types/logger";

// Type re-exports from engine interfaces (browser-safe — type-only, no runtime code pulled in)
export type {
  ActionExecutor,
  ActionExecutorOptions,
  DataProvider,
  DataQueryOptions,
  ExecuteOptions,
  ExecutionChannel,
  PendingEvent,
  TransactionManager,
} from "./engine/action-engine";
export type {
  ApprovalEngine,
  ApprovalEngineOptions,
  CreateApprovalOptions,
} from "./engine/approval-engine";
export type {
  CommandContext,
  CommandExecuteOptions,
  CommandLayer,
  CommandLayerOptions,
  MiddlewareHandler,
  MiddlewareRegistration,
  SlotName,
} from "./engine/command-layer";
export type {
  CreateProposalOptions,
  ProposalGeneratorDeps,
} from "./engine/proposal-engine";
export type {
  RuleEvalInput,
  RuleEvalOptions,
  RuleEvalOutput,
} from "./engine/rule-engine";
export type { StateMachine } from "./engine/state-machine";
export type { ValidationContext } from "./engine/validation-engine";
export type { TraceState } from "./observability/trace-context";
export type { FlowStepContext, FlowStepContextDeps } from "./flow";
// Class types (exported as type-only so consumers can use for annotations without pulling runtime)
export type { ActionRegistry } from "./engine/action-engine";
export type { PermissionRegistry } from "./engine/permission-engine";
export type { SchemaRegistry } from "./schema/schema-registry";
export type { EventBus, EventHandlerRegistry } from "./event/event-bus";

// Utilities
export { resolveEnvVars } from "./utils/env";
```

> **Note:** All engine interface/class types are re-exported as `export type` from main entry. This means consumers using `import type { ActionExecutor, SchemaRegistry } from "@linchkit/core"` continue to work — only VALUE imports (constructors, factory functions) must come from `@linchkit/core/server`.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck 2>&1 | head -80`
Expected: Errors in consumer files that import engine symbols from `@linchkit/core` — this is expected, fixed in Task 4.

---

### Task 3: Expand `server-entry.ts` — all runtime engines

**Files:**
- Modify: `packages/core/src/server-entry.ts`

- [ ] **Step 1: Rewrite server-entry.ts to include all runtime exports**

Replace the entire file with:

```typescript
/**
 * @linchkit/core/server — Server-only modules
 *
 * Runtime engines, database, Drizzle ORM, event bus, flow, observability, AI.
 * NOT safe for browser — requires Node/Bun runtime.
 *
 * Usage: import { createActionExecutor, SchemaRegistry } from "@linchkit/core/server"
 */

// === Engine: action, command, approval, state, rule, validation, permission, proposal ===

export {
  type ActionExecutor,
  type ActionExecutorOptions,
  ActionRegistry,
  createActionExecutor,
  type DataProvider,
  type DataQueryOptions,
  type ExecuteOptions,
  type ExecutionChannel,
  type PendingEvent,
  type TransactionManager,
} from "./engine/action-engine";

export {
  type ApprovalEngine,
  type ApprovalEngineOptions,
  type CreateApprovalOptions,
  createApprovalEngine,
  createApprovalVerifier,
  InMemoryApprovalStore,
} from "./engine/approval-engine";

export {
  type CommandContext,
  type CommandExecuteOptions,
  type CommandLayer,
  type CommandLayerOptions,
  createCommandLayer,
  ExposureError,
  type MiddlewareHandler,
  type MiddlewareRegistration,
  PipelineError,
  type SlotName,
} from "./engine/command-layer";

export {
  checkActionPermission,
  PermissionRegistry,
  resolveConditionVariables,
  resolveDataAccess,
} from "./engine/permission-engine";

export {
  bumpVersion,
  type CreateProposalOptions,
  createProposalEngine,
  ProposalEngine,
} from "./engine/proposal-engine";

export {
  createProposalGenerator,
  type ProposalGeneratorDeps,
} from "./engine/proposal-generator";

export {
  evaluateRules,
  type RuleEvalInput,
  type RuleEvalOptions,
  type RuleEvalOutput,
} from "./engine/rule-engine";

export type { StateMachine } from "./engine/state-machine";
export {
  canTransition,
  createStateMachine,
  getAvailableActions,
  transition,
} from "./engine/state-machine";

export {
  type ValidationContext,
  validatePhase1,
  validateProposal,
} from "./engine/validation-engine";

// === Schema registry ===

export { createSchemaRegistry, SchemaRegistry } from "./schema/schema-registry";
export { type DrizzleGeneratorOptions, generateDrizzleTable } from "./schema/schema-to-drizzle";
export { generateDrizzleSchemaFile } from "./schema/generate-drizzle-schema";

// === Event bus ===

export { createEventBus, EventBus, EventHandlerRegistry } from "./event/event-bus";
export { createPersistentEventBus, PersistentEventBus } from "./event/persistent-event-bus";
export {
  createOutboxWorker,
  type OutboxWorker,
  type OutboxWorkerOptions,
} from "./event/outbox-worker";

// === Observability ===

export { consoleLogger } from "./observability/console-logger";
export { InMemoryExecutionLogger } from "./observability/execution-logger";
export { getCurrentTrace, getTraceDepth, type TraceState, withTrace } from "./observability/trace-context";

// === AI service ===

export {
  createAIService,
  createNoopAIService,
  defaultAIConfig,
  resolveModel,
} from "./ai/ai-service";

// === Flow engine ===

export {
  type CompiledFlow,
  compileFlow,
  createFlowRegistry,
  createFlowStepContext,
  createSyncFlowEngine,
  createTriggerBinding,
  type FlowCompiler,
  type FlowEngine,
  type FlowEngineConfig,
  type FlowRegistry,
  FlowRegistryImpl,
  type FlowStepContext,
  type FlowStepContextDeps,
  type RestateConfig,
  type TriggerBinding,
} from "./flow";

// === Persistence: database, Drizzle ORM, migrations, system tables ===

export { closeDatabase, createDatabase, type DatabaseConfig } from "./persistence/database";
export { DrizzleApprovalStore } from "./persistence/drizzle-approval-store";
export { DrizzleDataProvider, type I18nQueryOptions } from "./persistence/drizzle-data-provider";
export { DrizzleExecutionLogger } from "./persistence/drizzle-execution-logger";
export * as drizzleSchema from "./persistence/drizzle-schema";
export { DrizzleTransactionManager } from "./persistence/drizzle-transaction-manager";
export { type MigrateOptions, runMigrations } from "./persistence/migrate";
export {
  approvalStatusEnum,
  approvalsTable,
  eventStatusEnum,
  eventsTable,
  executionStatusEnum,
  executionsTable,
} from "./persistence/system-tables";
export { TableRegistry } from "./persistence/table-registry";
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck 2>&1 | head -80`
Expected: Still errors in consumers — fixed in Task 4.

---

### Task 4: Update all consumer imports

**Files to update** (change `from "@linchkit/core"` → `from "@linchkit/core/server"` for server-only symbols):

#### 4A: packages/devtools/src/test-runtime.ts

- [ ] **Step 1: Update imports**

Change:
```typescript
import {
  type ActionRegistry,
  createActionExecutor,
  createEventBus,
  createSchemaRegistry,
  type EventBus,
  type SchemaRegistry,
} from "@linchkit/core";
```
To:
```typescript
import {
  type ActionRegistry,
  createActionExecutor,
  createEventBus,
  createSchemaRegistry,
  type EventBus,
  type SchemaRegistry,
} from "@linchkit/core/server";
```

#### 4B: capabilities/cap-adapter-server/src/runtime-context.ts

- [ ] **Step 2: Update imports**

Move server-only symbols from `@linchkit/core` to `@linchkit/core/server`. Keep type-only and define/error imports from `@linchkit/core`.

#### 4C: capabilities/cap-adapter-server/src/config-loader.ts

- [ ] **Step 3: Update import**

Change `consoleLogger` import from `@linchkit/core` to `@linchkit/core/server`.

#### 4D: capabilities/cap-adapter-server/src/graphql/build-schema.ts

- [ ] **Step 4: Update import**

`resolveTranslatableRow` is browser-safe (pure logic), so it stays in main entry. No change needed — verify it's still exported from `@linchkit/core` (we export it from `./schema/translatable`). ✅

#### 4E: capabilities/cap-adapter-server/src/graphql/schema-to-graphql.ts

- [ ] **Step 5: Update import**

Change `consoleLogger` import from `@linchkit/core` to `@linchkit/core/server`.

#### 4F: capabilities/cap-permission/src/middleware/permission-middleware.ts

- [ ] **Step 6: Update imports**

Move `checkActionPermission`, `resolveConditionVariables`, `resolveDataAccess` from `@linchkit/core` to `@linchkit/core/server`. Keep `AuthorizationError` from `@linchkit/core`.

#### 4G: linchkit.config.ts (root)

- [ ] **Step 7: Update import**

Move `PermissionRegistry` from `@linchkit/core` to `@linchkit/core/server`. Keep `defineConfig` from `@linchkit/core`.

#### 4H: packages/cli/src/commands/dev.ts

- [ ] **Step 8: Update imports**

This file imports many server-only symbols from `@linchkit/core`. Split into:
- Keep from `@linchkit/core`: `ConfigRegistry`, `databaseConfig`, `defineCapability`, and all `type` imports that are re-exported from main entry
- Move to `@linchkit/core/server`: `ActionRegistry`, `createActionExecutor`, `createApprovalEngine`, `createApprovalVerifier`, `createCommandLayer`, `createEventBus`, `InMemoryApprovalStore`, `InMemoryExecutionLogger`, `SchemaRegistry`, `consoleLogger`, and any other runtime factory/class value imports

#### 4I: Test files (batch update)

- [ ] **Step 9: Update all test file imports**

Files to update (move server-only symbols to `@linchkit/core/server`):
- `capabilities/cap-adapter-mcp/__tests__/tool-registry.test.ts` — `ActionRegistry`
- `capabilities/cap-adapter-mcp/__tests__/sse-transport.test.ts` — `ActionRegistry, createSchemaRegistry`
- `capabilities/cap-adapter-mcp/__tests__/mcp-server.test.ts` — `ActionRegistry, createSchemaRegistry`
- `capabilities/cap-adapter-server/__tests__/graphql-mutations.test.ts` — `createActionExecutor`
- `capabilities/cap-adapter-server/__tests__/custom-action-mutations.test.ts` — `createActionExecutor`
- `capabilities/cap-adapter-server/__tests__/graphql-drizzle.integration.test.ts` — move `createActionExecutor` from `@linchkit/core` import to the existing `@linchkit/core/server` import block
- `capabilities/cap-adapter-server/__tests__/rest-actions.test.ts` — `createActionExecutor, InMemoryExecutionLogger`
- `capabilities/cap-adapter-server/__tests__/e2e-purchase-flow.test.ts` — `createActionExecutor, InMemoryExecutionLogger, SchemaRegistry`
- `capabilities/cap-adapter-server/__tests__/runtime-context.test.ts` — `InMemoryExecutionLogger`
- `capabilities/cap-permission/__tests__/factory.test.ts` — `PermissionRegistry`
- `capabilities/cap-permission/__tests__/middleware.test.ts` — `PermissionRegistry`
- `e2e/purchase-flow.test.ts` — `createActionExecutor, InMemoryExecutionLogger, SchemaRegistry`

For each: keep `defineXxx`, error classes, and types from `@linchkit/core`; move runtime symbols to `@linchkit/core/server`.

---

### Task 5: Update internal core imports

**Files:**
- Modify: `packages/core/src/define-entry.ts` (no change needed — already browser-safe)
- Verify: `packages/core/src/types/config.ts` and `packages/core/src/types/transport.ts` — these import from `../engine`, check they still resolve

- [ ] **Step 1: Check and fix internal core imports**

`types/config.ts` and `types/transport.ts` import types from `../engine`. Since `engine/index.ts` still exports those types (just not sibling re-exports), these should still work. Verify with typecheck.

- [ ] **Step 2: Run full typecheck**

Run: `bun run typecheck`
Expected: PASS — no errors.

---

### Task 6: Run tests and verify

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All 936+ tests pass.

- [ ] **Step 2: Run biome check**

Run: `bun run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(core): split server/client entry points — make @linchkit/core browser-safe

Move all runtime engine exports (ActionRegistry, CommandLayer, EventBus, Flow,
SchemaRegistry, observability, AI) from main entry to @linchkit/core/server.

Main entry now only exports: types, define functions, errors, config, and
pure-logic utilities (condition evaluator, Zod generator, translatable).

Updated 23 consumer files to import server-only symbols from @linchkit/core/server."
```
