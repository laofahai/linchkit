#!/bin/bash
# PreToolUse hook for gh pr create — ensure cross-model review was done.
#
# Matcher `Bash(gh pr create*)` substring-matches the whole command string, so
# this hook fires for any Bash call whose content mentions "gh pr create"
# (e.g. a HEREDOC body in `gh issue create`). Parse the real tool input and
# only enforce on actual `gh pr create` invocations — matched at a shell
# command boundary (start-of-line or after `&&` / `||` / `;` / `|`), which
# also handles wrapped forms like `cd /repo && gh pr create ...`.

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

if ! printf '%s' "$COMMAND" | grep -Eq '(^|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  exit 0
fi

source "$(dirname "$0")/workflow-state.sh"

if ! wf_has cross_model_review; then
  echo "BLOCKED: Cross-model review not done." >&2
  echo "Run Step 5 (detect tools, ask user, run review) before creating PR." >&2
  exit 2
fi
