#!/bin/bash
# SessionStart hook — inject workflow state and git context on resume/compact.
source "$(dirname "$0")/workflow-state.sh"

wf_show
echo "## Current Branch"
git rev-parse --abbrev-ref HEAD 2>/dev/null
echo "## Uncommitted Changes"
git diff --stat 2>/dev/null
