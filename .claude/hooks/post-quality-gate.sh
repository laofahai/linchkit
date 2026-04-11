#!/bin/bash
# PostToolUse hook — record quality gate results.
# Called with $1 = gate name (check_passed | typecheck_passed | tests_passed)
source "$(dirname "$0")/workflow-state.sh"

wf_mark "$1"
