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

# There are uncommitted changes — show remaining workflow steps
echo "⚠ Uncommitted changes detected. Remaining workflow steps:"
echo ""

if ! wf_has check_passed; then
  echo "  □ bun run check        (not done)"
else
  echo "  ✓ bun run check"
fi

if ! wf_has typecheck_passed; then
  echo "  □ bun run typecheck    (not done)"
else
  echo "  ✓ bun run typecheck"
fi

if ! wf_has tests_passed; then
  echo "  □ bun test             (not done)"
else
  echo "  ✓ bun test"
fi

if ! wf_has cross_model_review; then
  echo "  □ Cross-model review   (not done)"
else
  echo "  ✓ Cross-model review"
fi

echo "  □ git commit"
echo "  □ gh pr create"
echo ""
echo "Consider completing these before ending the session."
