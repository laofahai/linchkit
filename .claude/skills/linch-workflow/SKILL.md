---
name: "linch:workflow"
description: "Master workflow router — invoke FIRST for every development task. Routes to correct sub-skill, enforces lifecycle phases, manages tools and PR process."
---

# LinchKit Development Workflow

**Invoke this skill BEFORE any development work.** It determines the correct approach based on task type.

## Step 0: Environment Check

Before doing anything else, verify your working environment:

1. **Check current branch**: `git rev-parse --abbrev-ref HEAD`
   - If `main` → STOP. Use `git worktree add .claude/worktrees/<name> -b <branch>` to create a worktree, then work there.
   - If a feature branch → proceed.
2. **Validate branch prefix**: Must start with `feat/`, `fix/`, `refactor/`, `docs/`, or `chore/`. Warn if invalid.
3. **Never use `git checkout -b`** — use `git worktree add` to create isolated work environments.

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
| **Infra / tooling** | Hooks, CI, build, config | None | NO |
| **Cross-category** | Touches multiple areas | Load all relevant sub-skills | MAYBE |

**After classifying:** Invoke the relevant sub-skill(s) using the `Skill` tool. For cross-category tasks, load multiple sub-skills and note which files belong to which concern. Then proceed to Step 2.

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

Quality gates MUST pass before committing.
Hooks track progress in a per-branch state file (via `.claude/hooks/workflow-state.sh`).
`git commit` is blocked until check/typecheck/test all pass. `linch validate` is manual.

```bash
linch validate        # Meta-model validation (manual — run when touching definitions)
bun run check         # Biome lint + format (hook-tracked)
bun run typecheck     # TypeScript strict check (hook-tracked)
bun test              # Full test suite (hook-tracked, must be exact `bun test` not filtered)
```

## Step 5: Cross-Model Review

Before creating a PR, request cross-model review for a second opinion.
**Must ask user for approval before invoking external tools.**

1. **Detect available tools** — check all known AI CLI tools:
   ```bash
   for cmd in codex gemini claude aider llm mods sgpt ollama fabric goose avante trae; do
     which "$cmd" 2>/dev/null && echo "FOUND: $cmd"
   done
   ```
   Known tools and their non-interactive modes:

   | Tool | Backend | Non-interactive mode |
   |------|---------|---------------------|
   | codex | OpenAI | `codex review --uncommitted` / `codex exec "<prompt>"` |
   | gemini | Google | `gemini -p "<prompt>"` or heredoc |
   | claude | Anthropic | `claude -p "<prompt>"` or heredoc |
   | aider | Multi-backend | `aider --message "<prompt>"` |
   | llm | Multi-backend (incl. OpenRouter) | `llm "<prompt>"` or stdin |
   | mods | Multi-backend (incl. OpenRouter) | stdin: `echo "<prompt>" \| mods` |
   | sgpt | OpenAI | `sgpt "<prompt>"` |
   | ollama | Local models | `ollama run <model> "<prompt>"` |
   | fabric | Multi-backend | `fabric -p "<prompt>"` |
   | goose | Multi-backend | `goose run "<prompt>"` |

   If a tool is found but not in this list, check `<tool> --help` for its non-interactive flag.
2. **Ask user**: "The following review tools are available: [list]. May I run cross-model review?" — proceed only with approval.
3. **Run reviews** — use heredoc to pass prompts safely (diffs contain special chars like `$`, backticks):
   ```bash
   # Codex has built-in review
   codex review --uncommitted
   # Other tools: use heredoc with tool-specific flag (see table above)
   # Example for gemini/claude (-p flag):
   gemini -p <<'EOF'
   Review the following changes: ...
   <diff>
   EOF
   # Example for tools that read stdin (llm, mods):
   llm <<'EOF'
   Review the following changes: ...
   <diff>
   EOF
   ```
4. **Second evaluation** — do NOT blindly accept all findings. For each issue:
   - Verify against documentation/source code — is the claim correct?
   - Assess severity — is this a real bug or a style preference?
   - Decide: **fix**, **reject** (with reason), or **defer** (low priority).
   Present the evaluation table to the user before proceeding.
5. **Fix confirmed issues**: Apply fixes, re-run quality gates if code changed.
6. **Mark complete**: `./.claude/hooks/post-quality-gate.sh cross_model_review`
   This is required — `gh pr create` is blocked by hook until this marker exists.

## Step 6: PR & Review

1. Verify you're on the correct feature branch (not `main`)
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

## Step 7: Close

1. Update `docs/specs/INDEX.md` if spec status changed
2. Add changeset if npm-published code changed: `bunx changeset`
3. Close related issues: `gh issue close <number>`
4. Clean up after merge:
   - Delete remote branch: `git push origin --delete <branch>`
   - Remove worktree (if used): `git worktree remove <path>`
   - Prune stale remote refs: `git remote prune origin`

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
