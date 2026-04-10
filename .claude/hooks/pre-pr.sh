#!/bin/bash
# PreToolUse hook for gh pr create — ensure cross-model review was done.
source "$(dirname "$0")/workflow-state.sh"

if ! wf_has cross_model_review; then
  echo "BLOCKED: Cross-model review not done." >&2
  echo "Run Step 5 (detect tools, ask user, run review) before creating PR." >&2
  exit 2
fi
