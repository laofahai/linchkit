#!/bin/bash
# PreToolUse hook for git commit — ensure quality gates are fresh.
#
# Claude Code's `if: "Bash(git commit*)"` matcher substring-matches the whole
# command string, so this hook receives invocations it shouldn't enforce on
# (e.g. `gh issue create --body "... git commit ..."`). We parse the real tool
# input from stdin and only enforce when `git commit` appears as an actual
# command boundary:
#   - at the start of the command, OR
#   - after a shell separator (`&&`, `||`, `;`, `|`).
# This correctly covers wrapped forms like `cd /repo && git commit -m x` or
# `git add . && git commit -m y` (required by the workflow) while still
# rejecting `git commit` inside a quoted argument.
#
# Known limitation: a quoted body that itself contains a separator + `git
# commit` (e.g. `gh issue create --body 'run ; git commit later'`) will still
# match, because the regex doesn't track shell quoting state. Fully
# quote-aware parsing in pure bash regex is impractical; this hook is a
# guardrail and `git commit` inside an issue-body argument is a narrow edge
# case. Re-run the skipped gates if you hit it.

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

if ! printf '%s' "$COMMAND" | grep -Eq '(^|[;&|])[[:space:]]*git[[:space:]]+commit([[:space:];&|]|$)'; then
  exit 0
fi

# Branch guard: refuse commits on main/master. CLAUDE.md mandates feature-
# branch worktrees for all changes; an accidental cd/pwd slip during parallel
# work just landed an empty commit on main (issue #291). This must run BEFORE
# the gate-freshness check so a fresh-gate state cannot bypass the guard.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "BLOCKED: refusing to commit on $BRANCH. Use 'git worktree add .claude/worktrees/<name> -b <branch>' for a feature branch." >&2
  exit 2
fi

source "$(dirname "$0")/workflow-state.sh"

MISSING=""
wf_fresh check_passed     || MISSING="$MISSING"$'\n  - bun run check'
wf_fresh typecheck_passed || MISSING="$MISSING"$'\n  - bun run typecheck'
wf_fresh tests_passed     || MISSING="$MISSING"$'\n  - bun run test'

if [ -n "$MISSING" ]; then
  printf 'BLOCKED: Quality gates not passed or stale:%s\n' "$MISSING" >&2
  echo "Run the listed commands before committing." >&2
  echo "(A gate becomes stale when tracked source files change, the tracked" >&2
  echo " file set changes (git add/rm/mv), or a repo-root config file changes" >&2
  echo " — tsconfig.json / biome.json / package.json / bun.lock / etc.)" >&2
  exit 2
fi
