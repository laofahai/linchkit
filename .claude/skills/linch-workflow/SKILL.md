---
name: "linch:workflow"
description: "Master workflow router — invoke FIRST for every development task. Routes to correct sub-skill, enforces lifecycle phases, manages tools and PR process."
---

# LinchKit Development Workflow

**Invoke this skill BEFORE any development work.** It determines the correct approach based on task type.

## Step 1: Classify the Task

Read the user's request and classify:

| Type | Signal | Sub-skills to load | Use MCP tools? |
|------|--------|-------------------|----------------|
| **Capability dev** | New addon, defineEntity/Action/View | `/linch-capability-dev` + domain skills | YES — `ToolSearch("mcp__linchkit")` then `list_entities`, `get_entity` |
| **Core engine dev** | New engine, runtime changes, life-system | `/linch-engine-dev` | NO — read specs + source code |
| **Bug fix** | "fix", error report, failing test | `/test` | MAYBE — if entity-related |
| **UI development** | View, form, component, widget | `/linch-view-design` | YES — `get_entity` for field info |
| **Refactoring** | Rename, extract, reorganize | `/linch-architecture` | MAYBE |
| **Docs / specs** | Write spec, update docs | None | NO |

**After classifying:** Invoke the relevant sub-skill(s) using the `Skill` tool. Then proceed to Step 2.

## Step 2: Orient

1. **Check existing issues first** — `gh issue list --state open --limit 100` — look for duplicates, related issues, and blocking dependencies before creating new issues or starting work. Add "Blocked by #xxx" or "Related: #xxx" to issue bodies when relationships exist.
2. Read the related spec (`docs/specs/INDEX.md` → find spec → read it)
3. If working from a GitHub issue: `gh issue view <number>`
4. If touching existing code: Use Serena MCP (`get_symbols_overview`, `find_symbol`) for token-efficient code reading. Fall back to `Read` for non-code files only.

## Step 3: Design First

1. **Data structures before logic** — Define types and interfaces first
2. **Write tests alongside code** — Use `/test` skill. Not after.
3. **Keep files under 500 lines** — Split by responsibility
4. **Unrelated issues** — Don't fix in same PR. Create `gh issue create` to track.

## Step 4: Verify

All four quality gates MUST pass before committing:

```bash
linch validate        # Meta-model validation
bun run check         # Biome lint + format
bun run typecheck     # TypeScript strict check
bun test              # Full test suite
```

## Step 5: PR & Review

1. Create branch — `feat/xxx`, `fix/xxx`, `refactor/xxx`
2. Push and create PR — `gh pr create`
3. Wait for CI
4. Read ALL review comments (CodeRabbit, Gemini, human)
5. Fix every comment, reply explaining what changed, then resolve thread (NEVER dismiss)
6. Merge only when: APPROVED + CI green

**PR merge rules (no exceptions):**
- NEVER `--admin` or `--auto` — blocked = not ready
- NEVER merge with CHANGES_REQUESTED — wait for re-approval
- NEVER dismiss review threads — reply + resolve
- ALWAYS read ALL comments BEFORE merge attempt

## Step 6: Close

1. Update `docs/specs/INDEX.md` if spec status changed
2. Add changeset if npm-published code changed: `bunx changeset`
3. Close related issues: `gh issue close <number>`
4. Delete merged branch: `git branch -d <branch>`
5. Clean worktrees if used: `git worktree remove ...`
6. Prune remote: `git remote prune origin`

---

## Parallel Subagent Dispatch

When multiple independent issues can run simultaneously:

1. **Orchestrator invokes Skills first** — Sub-skills only run in main agent. Load the skill, extract checklist/constraints, include them in the subagent prompt.
2. **Subagents only write code** — Dispatch with `isolation: "worktree"`. No `git commit/push` or `gh pr create`.
3. **Subagents use MCP tools** — Include in prompt: "Use `ToolSearch('mcp__linchkit')` to load MCP tools for entity/action discovery."
4. **Worktree starts from main** — Don't `git checkout` other branches.
5. **Orchestrator handles git** — Copy files from worktree via `cp`, commit, push, create PR.
6. **No file overlap** — Parallel branches must not touch same files.
7. **Bash `cd` persists** — Always `cd /absolute/path && git ...` in one call.

## Hygiene

- Never leave worktrees after task completion
- Never leave local branches after PR merge
- Session start: clean stale worktrees/branches from prior sessions
- New issues must have a priority label (P0-P3)

## MCP Tools Quick Reference

**LinchKit MCP** (for entity/action/capability work):
```text
ToolSearch("mcp__linchkit") → load tools
list_entities / get_entity / list_actions / get_rules / get_state_machine
scaffold_capability / scaffold_action / scaffold_rule
query (GraphQL)
```

**Serena MCP** (for token-efficient code reading):
```text
get_symbols_overview — file structure (~90% fewer tokens than Read)
find_symbol with include_body=true — read specific function/class
find_referencing_symbols — find usages
search_for_pattern — regex search with scope
```
