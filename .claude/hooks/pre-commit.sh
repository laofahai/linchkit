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

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

if ! printf '%s' "$COMMAND" | grep -Eq '(^|[;&|])[[:space:]]*git[[:space:]]+commit([[:space:];&|]|$)'; then
  exit 0
fi

source "$(dirname "$0")/workflow-state.sh"

MISSING=""
wf_fresh check_passed     || MISSING="$MISSING bun-run-check"
wf_fresh typecheck_passed || MISSING="$MISSING bun-run-typecheck"
wf_fresh tests_passed     || MISSING="$MISSING bun-test"

if [ -n "$MISSING" ]; then
  echo "BLOCKED: Quality gates not passed or stale:$MISSING" >&2
  echo "Run the listed commands before committing." >&2
  echo "(A gate becomes stale when tracked source files change or the repo-root" >&2
  echo " config — tsconfig.json / biome.json / package.json / bun.lock — changes.)" >&2
  exit 2
fi
