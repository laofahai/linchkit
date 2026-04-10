#!/bin/bash
# PreToolUse hook for git commit — ensure quality gates passed.
source "$(dirname "$0")/workflow-state.sh"

MISSING=""
wf_has check_passed    || MISSING="$MISSING bun-run-check"
wf_has typecheck_passed || MISSING="$MISSING bun-run-typecheck"
wf_has tests_passed    || MISSING="$MISSING bun-test"

if [ -n "$MISSING" ]; then
  echo "BLOCKED: Quality gates not passed:$MISSING" >&2
  echo "Run them before committing." >&2
  exit 2
fi
