/**
 * Workflow and engine development skill templates
 */

export function workflowSkillContent(): string {
  return `---
name: "linch:workflow"
description: "Master workflow router — invoke FIRST for every development task. Routes to correct sub-skill, enforces lifecycle phases, manages tools and PR process."
---

# LinchKit Development Workflow

**Invoke this skill BEFORE any development work.** It determines the correct approach based on task type.

## Step 1: Classify the Task

| Type | Signal | Sub-skills to load | Use MCP tools? |
|------|--------|-------------------|----------------|
| **Capability dev** | New addon, defineEntity/Action/View | \`/linch-capability-dev\` + domain skills | YES — load MCP tools then \`list_entities\`, \`get_entity\` |
| **Core engine dev** | New engine, runtime changes, life-system | \`/linch-engine-dev\` | NO — read specs + source code |
| **Bug fix** | "fix", error report, failing test | \`/test\` | MAYBE — if entity-related |
| **UI development** | View, form, component, widget | \`/linch-view-design\` | YES — \`get_entity\` for field info |
| **Refactoring** | Rename, extract, reorganize | \`/linch-architecture\` | MAYBE |
| **Docs / specs** | Write spec, update docs | None | NO |

**After classifying:** Invoke the relevant sub-skill(s). Then proceed to Step 2.

## Step 2: Orient

1. Read the related spec (\`docs/specs/INDEX.md\` → find spec → read it)
2. If working from a GitHub issue: \`gh issue view <number>\`
3. If touching existing code: use semantic code reading tools for token-efficient navigation

## Step 3: Design First

1. **Data structures before logic** — Define types and interfaces first
2. **Write tests alongside code** — Not after.
3. **Keep files under 500 lines** — Split by responsibility
4. **Unrelated issues** — Don't fix in same PR. Create issue to track.

## Step 4: Verify

All four quality gates MUST pass before committing:
\`\`\`bash
linch validate && bun run check && bun run typecheck && bun test
\`\`\`

## Step 5: PR & Review

1. Create branch, push, create PR
2. Read ALL review comments — fix every one, reply, resolve thread (NEVER dismiss)
3. Merge only when: APPROVED + CI green
4. NEVER use \`--admin\` or \`--auto\` flags

## Step 6: Close

1. Update \`docs/specs/INDEX.md\` if spec status changed
2. Add changeset if npm code changed
3. Close related issues, delete branch, clean worktrees

## Parallel Subagent Dispatch

1. Orchestrator invokes Skills first — include constraints in subagent prompt
2. Subagents only write code — worktree isolation, no git/gh ops
3. Orchestrator handles git — copy files, commit, push, create PR
4. No file overlap between parallel branches
`;
}

export function engineDevSkillContent(): string {
  return `---
name: "linch:engine-dev"
description: "Core engine development: interface design, EventBus integration, test patterns, engine registration"
---

# Core Engine Development

For building or modifying core runtime engines (life-system, rule engine, state machine, etc.).

## When to Use

- Building new engines (AwarenessEngine, InsightEngine, etc.)
- Modifying existing engines (ActionEngine, RuleEngine, StateMachine)
- Life-system work (Sense, Memory, Awareness, Insight, Proposal)

## Workflow

### 1. Read the Spec
Core engines always have specs. Read the spec FIRST:
- Life system → Spec 55
- Rule engine → Spec 23
- State machine → Spec 32
- Action/execution → Specs 04, 39
- CommandLayer → Spec 16

### 2. Study Existing Engine Patterns
\`\`\`
packages/core/src/
├── engines/           # ActionEngine, RuleEngine, StateMachine
├── life-system/       # SignalBus, AwarenessEngine, BaselineTracker
└── types/             # Engine interfaces, life-system types
\`\`\`

### 3. Design the Interface First
Every engine MUST have:
- A TypeScript interface in \`types/\`
- A factory function \`createXxxEngine(options)\`
- No class inheritance — use composition
- EventBus integration — engines communicate via events

### 4. Integration Points
| Integration | How |
|-------------|-----|
| **EventBus** | \`eventBus.emit()\` / \`eventBus.on()\` — no direct engine calls |
| **Store** | Inject via options |
| **CommandLayer** | Register as middleware if needed |
| **Lifecycle** | Register in \`server-entry.ts\` |

### 5. Core Boundary Check
"Without this, is a zero-capability LinchKit still AI-Native?"
- YES → capability, not core
- NO → core is correct

## Checklist
- [ ] Spec read and understood
- [ ] TypeScript interface in \`types/\`
- [ ] Factory function \`createXxxEngine()\`
- [ ] EventBus integration
- [ ] Dependencies injected via options
- [ ] Tests with in-memory store
- [ ] File under 500 lines
- [ ] All quality gates pass
`;
}
