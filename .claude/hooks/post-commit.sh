#!/bin/bash
# PostToolUse hook for git commit — check changeset need and reset quality gates.
# Preserves cross_model_review marker so gh pr create is not blocked after fixup commits.
source "$(dirname "$0")/workflow-state.sh"

# Check if npm-published code changed
if git rev-parse HEAD~1 >/dev/null 2>&1 \
  && git diff HEAD~1 --name-only | grep -qE '^(packages|addons)/'; then
  echo "npm-published code changed. Run bunx changeset if this needs a version bump."
fi

# Reset only quality gate markers (not cross_model_review)
WF=$(_wf_file)
if [ -f "$WF" ]; then
  sed -i.bak '/^check_passed=/d;/^typecheck_passed=/d;/^tests_passed=/d' "$WF"
  rm -f "${WF}.bak"
fi
