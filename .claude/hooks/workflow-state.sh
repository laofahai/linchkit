#!/bin/bash
# Workflow state helper — shared by all workflow hooks.
# State file: $TMPDIR/linchkit-wf-<branch-slug>
# Each line: key=timestamp

_wf_file() {
  local branch project_id
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')
  # Include project path hash to avoid collisions between repos with same branch name
  project_id=$(printf "%s" "$(git rev-parse --show-toplevel 2>/dev/null)" | cksum | cut -d' ' -f1)
  echo "${TMPDIR:-/tmp/}linchkit-wf-${project_id}-${branch}"
}

wf_has() {
  # Check if a workflow step has been recorded.
  # Usage: wf_has tests_passed
  # Anchored to line start to prevent "check_passed" matching "typecheck_passed"
  grep -q "^$1=" "$(_wf_file)" 2>/dev/null
}

wf_mark() {
  # Record a workflow step as done.
  # Usage: wf_mark tests_passed
  echo "$1=$(date +%s)" >> "$(_wf_file)"
}

wf_reset() {
  # Clear all workflow state (called after commit).
  > "$(_wf_file)" 2>/dev/null || true
}

wf_show() {
  # Display current workflow state.
  local wf
  wf=$(_wf_file)
  if [ -f "$wf" ] && [ -s "$wf" ]; then
    echo "## Workflow Progress"
    cat "$wf"
    echo "---"
  fi
}
