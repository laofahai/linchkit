#!/usr/bin/env bash
# review-gate.sh — Post-merge automated review gate
# Usage: review-gate.sh <base-branch> <feature-branch> [--auto-revert] [--large]
#
# Runs multi-review.sh --json after a merge commit.
# PASS → exit 0 (no output beyond JSON report)
# FAIL → prints structured fix instructions to stdout, exits 1
#        With --auto-revert: also reverts the last merge commit before exiting 1
#
# Exit codes: 0 = review passed, 1 = review failed, 2 = error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MULTI_REVIEW="${SCRIPT_DIR}/multi-review.sh"

# ── Args ──────────────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <base-branch> <feature-branch> [--auto-revert] [--large]" >&2
  exit 2
fi

BASE_BRANCH="$1"
FEATURE_BRANCH="$2"
AUTO_REVERT=false
FORCE_LARGE=""

for arg in "${@:3}"; do
  case "$arg" in
    --auto-revert) AUTO_REVERT=true ;;
    --large)       FORCE_LARGE="--large" ;;
  esac
done

if [[ ! -x "$MULTI_REVIEW" ]]; then
  echo "ERROR: multi-review.sh not found or not executable at ${MULTI_REVIEW}" >&2
  exit 2
fi

# ── Run JSON review ───────────────────────────────────────────────────────────
REVIEW_JSON=""
REVIEW_EXIT=0

if [[ -n "$FORCE_LARGE" ]]; then
  REVIEW_JSON="$(bash "$MULTI_REVIEW" "$BASE_BRANCH" "$FEATURE_BRANCH" --json --large 2>&1)" || REVIEW_EXIT=$?
else
  REVIEW_JSON="$(bash "$MULTI_REVIEW" "$BASE_BRANCH" "$FEATURE_BRANCH" --json 2>&1)" || REVIEW_EXIT=$?
fi

if [[ $REVIEW_EXIT -eq 2 ]]; then
  echo "ERROR: multi-review.sh encountered an error" >&2
  echo "$REVIEW_JSON" >&2
  exit 2
fi

# ── Parse verdict ─────────────────────────────────────────────────────────────
VERDICT="$(echo "$REVIEW_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('verdict','FAIL'))" 2>/dev/null || echo "FAIL")"

if [[ "$VERDICT" == "PASS" ]]; then
  echo "$REVIEW_JSON"
  exit 0
fi

# ── FAIL: auto-revert if requested ───────────────────────────────────────────
if $AUTO_REVERT; then
  LAST_COMMIT="$(git log --merges --format="%H" -1 2>/dev/null || git log --format="%H" -1)"
  if [[ -n "$LAST_COMMIT" ]]; then
    git revert --no-edit "$LAST_COMMIT" 2>&1 >&2 || {
      echo "WARNING: git revert failed for commit ${LAST_COMMIT}" >&2
    }
  fi
fi

# ── Emit structured fix instructions ─────────────────────────────────────────
python3 - "$REVIEW_JSON" "$BASE_BRANCH" "$FEATURE_BRANCH" <<'PYEOF'
import sys
import json

review_json_str = sys.argv[1]
base_branch     = sys.argv[2]
feature_branch  = sys.argv[3]

try:
    data = json.loads(review_json_str)
except (json.JSONDecodeError, ValueError):
    data = {"verdict": "FAIL", "reviews": []}

reviews = data.get("reviews", [])

# Collect all issues across reviewers
all_issues = []
for review in reviews:
    reviewer = review.get("reviewer", "unknown")
    for issue in review.get("issues", []):
        all_issues.append({
            "reviewer": reviewer,
            "file": issue.get("file", "unknown"),
            "line": issue.get("line"),
            "severity": issue.get("severity", "error"),
            "message": issue.get("message", ""),
            "suggestion": issue.get("suggestion", "")
        })

output = {
    "verdict": "FAIL",
    "base_branch": base_branch,
    "feature_branch": feature_branch,
    "reviews": reviews,
    "fix_instructions": all_issues
}

print(json.dumps(output, indent=2))
PYEOF

exit 1
