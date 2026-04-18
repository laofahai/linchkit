#!/bin/bash
# PostToolUse hook for git commit — notify about changeset need.
#
# Matcher `Bash(git commit*)` substring-matches the whole command, so verify
# the real command before acting on it. We match `git commit` at a shell
# command boundary so wrapped forms (`cd /r && git commit`) still fire this.
#
# Historically this hook also wiped quality-gate markers after every commit.
# That forced re-running the full gate suite on every follow-up commit in
# review-fix flows. We now rely on `wf_fresh` (in workflow-state.sh) to check
# whether tracked source/root-config files changed since the last marker —
# the markers stay valid as long as the code hasn't changed, and become stale
# automatically when it does.

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

if ! printf '%s' "$COMMAND" | grep -Eq '(^|[;&|])[[:space:]]*git[[:space:]]+commit([[:space:]]|$)'; then
  exit 0
fi

# Check if npm-published code changed (commit-scoped, not work-tree)
if git rev-parse HEAD~1 >/dev/null 2>&1 \
  && git diff-tree --no-commit-id --name-only -r HEAD | grep -qE '^(packages|addons)/'; then
  echo "npm-published code changed. Run bunx changeset if this needs a version bump."
fi
