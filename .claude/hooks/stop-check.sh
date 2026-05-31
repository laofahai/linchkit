#!/bin/bash
# Stop hook — remind about remaining workflow steps if work is uncommitted.
source "$(dirname "$0")/workflow-state.sh"

# Check for any local changes including untracked files
CHANGES=$(git status --porcelain --untracked-files=normal 2>/dev/null)

if [ -z "$CHANGES" ]; then
  # No changes — just remind about spec status
  echo "Reminder: If you changed spec implementation status, update docs/specs/INDEX.md."
  exit 0
fi

# gate_row <marker> <label> — print one line, flagging stale gates.
gate_row() {
  local marker="$1" label="$2"
  if wf_fresh "$marker"; then
    echo "  ✓ $label"
  elif wf_has "$marker"; then
    echo "  ⚠ $label    (stale — source changed since it ran)"
  else
    echo "  □ $label    (not done)"
  fi
}

echo "⚠ Uncommitted changes detected. Remaining workflow steps:"
echo ""

gate_row check_passed     "bun run check       "
gate_row typecheck_passed "bun run typecheck   "
gate_row tests_passed     "bun run test        "
gate_row cross_model_review "Cross-model review "

echo "  □ git commit"
echo "  □ gh pr create"
echo ""
echo "Consider completing these before ending the session."
