/**
 * Workflow and engine development skill templates.
 *
 * These MUST stay in sync with the actual SKILL.md files:
 *   .claude/skills/linch-workflow/SKILL.md
 *   .claude/skills/linch-engine-dev/SKILL.md
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read a SKILL.md file from the .claude/skills directory.
 * Falls back to inline content if the file doesn't exist (e.g. when used
 * from a downstream project that hasn't run `linch setup` yet).
 */
function readSkillFile(slug: string): string | null {
  try {
    const skillPath = resolve(import.meta.dir, "../../../../.claude/skills", slug, "SKILL.md");
    return readFileSync(skillPath, "utf-8");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw error;
  }
}

export function workflowSkillContent(): string {
  return (
    readSkillFile("linch-workflow") ??
    `---
name: "linch:workflow"
description: "Master workflow router — invoke FIRST for every development task. Routes to correct sub-skill, enforces lifecycle phases, manages tools and PR process."
---

# LinchKit Development Workflow

**Invoke this skill BEFORE any development work.** It determines the correct approach based on task type.

## Step 1: Classify the Task

Read the user's request and classify:

| Type | Signal | Sub-skills to load | Use MCP tools? |
|------|--------|-------------------|----------------|
| **Capability dev** | New addon, defineEntity/Action/View | \`/linch-capability-dev\` + domain skills | YES — \`ToolSearch("mcp__linchkit")\` then \`list_entities\`, \`get_entity\` |
| **Core engine dev** | New engine, runtime changes, life-system | \`/linch-engine-dev\` | NO — read specs + source code |
| **Bug fix** | "fix", error report, failing test | \`/test\` | MAYBE — if entity-related |
| **UI development** | View, form, component, widget | \`/linch-view-design\` | YES — \`get_entity\` for field info |
| **Refactoring** | Rename, extract, reorganize | \`/linch-architecture\` | MAYBE |
| **Docs / specs** | Write spec, update docs | None | NO |

**After classifying:** Invoke the relevant sub-skill(s) using the \`Skill\` tool. Then proceed to Step 2.

## Step 2: Orient

1. **Check existing issues first** — \`gh issue list --state open --limit 100\` — look for duplicates, related issues, and blocking dependencies before creating new issues or starting work. Add "Blocked by #xxx" or "Related: #xxx" to issue bodies when relationships exist.
2. Read the related spec (\`docs/specs/INDEX.md\` → find spec → read it)
3. If working from a GitHub issue: \`gh issue view <number>\`
4. If touching existing code: Use Serena MCP (\`get_symbols_overview\`, \`find_symbol\`) for token-efficient code reading. Fall back to \`Read\` for non-code files only.

## Step 3: Design First

1. **Data structures before logic** — Define types and interfaces first
2. **Write tests alongside code** — Use \`/test\` skill. Not after.
3. **Keep files under 500 lines** — Split by responsibility
4. **Unrelated issues** — Don't fix in same PR. Create \`gh issue create\` to track.

## Step 4: Verify

All four quality gates MUST pass before committing:

\`\`\`bash
linch validate        # Meta-model validation
bun run check         # Biome lint + format
bun run typecheck     # TypeScript strict check
bun test              # Full test suite
\`\`\`

## Step 5: PR & Review

1. Create branch — \`feat/xxx\`, \`fix/xxx\`, \`refactor/xxx\`
2. Push and create PR — \`gh pr create\`
3. Wait for CI
4. Read ALL review comments (CodeRabbit, Gemini, human)
5. Fix every comment, reply explaining what changed, then resolve thread (NEVER dismiss)
6. Merge only when: APPROVED + CI green

**PR merge rules (no exceptions):**
- NEVER \`--admin\` or \`--auto\` — blocked = not ready
- NEVER merge with CHANGES_REQUESTED — wait for re-approval
- NEVER dismiss review threads — reply + resolve
- ALWAYS read ALL comments BEFORE merge attempt

## Step 6: Close

1. Update \`docs/specs/INDEX.md\` if spec status changed
2. Add changeset if npm-published code changed: \`bunx changeset\`
3. Close related issues: \`gh issue close <number>\`
4. Delete merged branch: \`git branch -d <branch>\`
5. Clean worktrees if used: \`git worktree remove ...\`
6. Prune remote: \`git remote prune origin\`

---

## Parallel Subagent Dispatch

When multiple independent issues can run simultaneously:

1. **Orchestrator invokes Skills first** — Sub-skills only run in main agent. Load the skill, extract checklist/constraints, include them in the subagent prompt.
2. **Subagents only write code** — Dispatch with \`isolation: "worktree"\`. No \`git commit/push\` or \`gh pr create\`.
3. **Subagents use MCP tools** — Include in prompt: "Use \`ToolSearch('mcp__linchkit')\` to load MCP tools for entity/action discovery."
4. **Worktree starts from main** — Don't \`git checkout\` other branches.
5. **Orchestrator handles git** — Copy files from worktree via \`cp\`, commit, push, create PR.
6. **No file overlap** — Parallel branches must not touch same files.
7. **Bash \`cd\` persists** — Always \`cd /absolute/path && git ...\` in one call.

## Hygiene

- Never leave worktrees after task completion
- Never leave local branches after PR merge
- Session start: clean stale worktrees/branches from prior sessions
- New issues must have a priority label (P0-P3)

## MCP Tools Quick Reference

**LinchKit MCP** (for entity/action/capability work):
\`\`\`text
ToolSearch("mcp__linchkit") → load tools
list_entities / get_entity / list_actions / get_rules / get_state_machine
scaffold_capability / scaffold_action / scaffold_rule
query (GraphQL)
\`\`\`

**Serena MCP** (for token-efficient code reading):
\`\`\`text
get_symbols_overview — file structure (~90% fewer tokens than Read)
find_symbol with include_body=true — read specific function/class
find_referencing_symbols — find usages
search_for_pattern — regex search with scope
\`\`\`
`
  );
}

export function engineDevSkillContent(): string {
  return (
    readSkillFile("linch-engine-dev") ??
    `---
name: "linch:engine-dev"
description: "Core engine development: interface design, EventBus integration, test patterns, engine registration"
---

# Core Engine Development

For building or modifying core runtime engines (life-system, rule engine, state machine, etc.).
This is NOT for capability development — use \`/linch-capability-dev\` for that.

## When to Use

- Building new engines (e.g., AwarenessEngine, InsightEngine)
- Modifying existing engines (ActionEngine, RuleEngine, StateMachine)
- Adding core runtime features (new pipeline slots, new event types)
- Life-system work (Sense, Memory, Awareness, Insight, Proposal)

## Workflow

### 1. Read the Spec

Core engines always have specs. Read the spec FIRST:
- Life system → Spec 55 (\`docs/specs/55_evolution_system.md\`)
- Rule engine → Spec 23
- State machine → Spec 32
- Action/execution → Specs 04, 39
- CommandLayer → Spec 16

### 2. Study Existing Engine Patterns

All core engines follow the same pattern. Read an existing engine to understand:

\`\`\`text
packages/core/src/
├── engines/
│   ├── action-engine.ts       # ActionEngine — createActionEngine()
│   ├── rule-engine.ts         # RuleEngine — createRuleEngine()
│   └── state-machine.ts       # StateMachine — createStateMachine()
├── life-system/
│   ├── signal-bus.ts          # SignalBus — event backbone
│   ├── awareness-engine.ts    # AwarenessEngine — pattern detection
│   ├── baseline-tracker.ts    # BaselineTracker — statistical baselines
│   └── index.ts               # Public exports
└── types/
    ├── engine.ts              # Engine interfaces
    └── life-system.ts         # Life-system types
\`\`\`

### 3. Design the Interface First

Every engine MUST have:
- **A TypeScript interface** — in \`packages/core/src/types/\`
- **A factory function** — \`createXxxEngine(options): XxxEngine\`
- **No class inheritance** — use composition and factory functions
- **EventBus integration** — engines communicate via events, not direct calls

\`\`\`ts
// types/my-engine.ts
export interface MyEngine {
  process(input: MyInput): Promise<MyOutput>;
  dispose(): void;
}

export interface MyEngineOptions {
  eventBus: EventBus;
  store: Store;
  // ... dependencies injected via options
}
\`\`\`

\`\`\`ts
// engines/my-engine.ts
export function createMyEngine(options: MyEngineOptions): MyEngine {
  const { eventBus, store } = options;
  // ... implementation
  return { process, dispose };
}
\`\`\`

### 4. Integration Points

| Integration | How |
|-------------|-----|
| **EventBus** | \`eventBus.emit()\` / \`eventBus.on()\` — engines never call each other directly |
| **Store** | Inject via options, use for persistence |
| **CommandLayer** | If engine affects action execution, register as middleware |
| **Config** | Use \`defineConfigSchema()\` for engine configuration |
| **Lifecycle** | Register in \`server-entry.ts\` for boot/shutdown |

### 5. Testing

Core engine tests go in \`packages/core/src/__tests__/\`:

\`\`\`ts
import { describe, expect, test } from "bun:test";
import { createMyEngine } from "../../engines/my-engine";
import { createSignalBus } from "../../life-system/signal-bus";
import { InMemoryMemoryStore } from "../../life-system/in-memory-memory-store";

describe("MyEngine", () => {
  test("processes input correctly", async () => {
    const signalBus = createSignalBus();
    const store = new InMemoryMemoryStore();
    const engine = createMyEngine({ signalBus, store });

    const result = await engine.process({ ... });
    expect(result).toEqual({ ... });
  });
});
\`\`\`

### 6. Core Boundary Check

Before adding to core, verify:
- "Without this, is a zero-capability LinchKit still AI-Native?"
- If YES → this belongs in a capability, not core
- If NO → core is correct

Life-system engines (Sense, Memory, Awareness, Insight, Proposal) are always core — they make LinchKit AI-Native.

## Checklist

- [ ] Spec read and understood
- [ ] TypeScript interface defined in \`types/\`
- [ ] Factory function \`createXxxEngine()\` implemented
- [ ] EventBus integration (no direct engine-to-engine calls)
- [ ] Dependencies injected via options object
- [ ] Tests in \`__tests__/\` with in-memory store
- [ ] Registered in \`server-entry.ts\` if needed
- [ ] File under 500 lines
- [ ] All quality gates pass
`
  );
}
