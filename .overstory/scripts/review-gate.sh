#!/usr/bin/env bash
# review-gate.sh — Post-merge review gate for overstory workflow
# Usage: review-gate.sh <base-branch> <feature-branch> [--auto-revert] [--output <file>] [--large]
# Exit codes: 0 = PASS, 1 = FAIL (review failed), 2 = error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Args ──────────────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <base-branch> <feature-branch> [--auto-revert] [--output <file>] [--large]" >&2
  exit 2
fi

BASE_BRANCH="$1"
FEATURE_BRANCH="$2"
AUTO_REVERT=false
OUTPUT_FILE=""
EXTRA_FLAGS=""

# Parse flags
i=3
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --auto-revert) AUTO_REVERT=true ;;
    --output)
      i=$((i + 1))
      OUTPUT_FILE="${!i}"
      ;;
    --large) EXTRA_FLAGS="$EXTRA_FLAGS --large" ;;
  esac
  i=$((i + 1))
done

# ── Run multi-review with JSON output ────────────────────────────────────────
TMPDIR_GATE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_GATE"' EXIT
REVIEW_JSON_FILE="$TMPDIR_GATE/review-result.json"

REVIEW_EXIT=0
# shellcheck disable=SC2086
if ! "$SCRIPT_DIR/multi-review.sh" "$BASE_BRANCH" "$FEATURE_BRANCH" --json $EXTRA_FLAGS > "$REVIEW_JSON_FILE" 2>&1; then
  REVIEW_EXIT=$?
fi

REVIEW_JSON="$(cat "$REVIEW_JSON_FILE")"

# ── Save output if requested ──────────────────────────────────────────────────
if [[ -n "$OUTPUT_FILE" ]]; then
  echo "$REVIEW_JSON" > "$OUTPUT_FILE"
fi

# ── Parse verdict ─────────────────────────────────────────────────────────────
VERDICT="$(echo "$REVIEW_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('verdict','UNKNOWN').upper())
except Exception as e:
    print('UNKNOWN')
" 2>/dev/null || echo "UNKNOWN")"

# ── Handle PASS ───────────────────────────────────────────────────────────────
if [[ "$VERDICT" == "PASS" ]]; then
  echo "REVIEW GATE: PASS"
  echo ""
  echo "$REVIEW_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    summary = data.get('summary', '')
    if summary:
        print('Summary: ' + summary)
except:
    pass
" 2>/dev/null || true
  exit 0
fi

# ── Handle FAIL ───────────────────────────────────────────────────────────────
echo "REVIEW GATE: FAIL"
echo ""

# Print structured fix instructions
echo "$REVIEW_JSON" | python3 -c "
import sys, json

try:
    data = json.load(sys.stdin)
    reviews = data.get('reviews', [])
    all_issues = data.get('all_issues', [])

    # Dedup issues across reviewers if all_issues not set
    if not all_issues:
        for r in reviews:
            all_issues.extend(r.get('issues', []))

    print('=== Review Failures ===')
    for rev in reviews:
        reviewer = rev.get('reviewer', 'unknown')
        verdict = rev.get('verdict', 'UNKNOWN')
        summary = rev.get('summary', '')
        print(f'  {reviewer}: {verdict}')
        if summary:
            print(f'    Summary: {summary}')

    if all_issues:
        print('')
        print('=== Issues Requiring Fixes ===')
        for i, issue in enumerate(all_issues, 1):
            file_path = issue.get('file', 'unknown')
            line = issue.get('line', 0)
            severity = issue.get('severity', 'error')
            message = issue.get('message', '')
            suggestion = issue.get('suggestion', '')
            loc = f'{file_path}:{line}' if line else file_path
            print(f'{i}. [{severity.upper()}] {loc}')
            print(f'   Issue: {message}')
            if suggestion:
                print(f'   Fix:   {suggestion}')
    else:
        print('')
        print('No structured issues extracted. Review output follows:')
        for rev in reviews:
            print(f'--- {rev.get(\"reviewer\",\"unknown\")} ---')
            print(rev.get('summary', '(no summary)'))

except Exception as e:
    print(f'ERROR parsing review JSON: {e}')
    sys.exit(1)
" 2>/dev/null || echo "ERROR: Failed to parse review output"

echo ""
echo "=== Fix Instructions ==="
echo "The above issues must be resolved before this branch can be merged."
echo "To apply fixes:"
echo "  1. Address each issue listed above in the feature branch"
echo "  2. Commit the fixes"
echo "  3. Re-run the merge + review gate"

# ── Auto-revert if requested ──────────────────────────────────────────────────
if $AUTO_REVERT; then
  echo ""
  echo "=== Auto-revert: reverting last merge commit ==="
  if git revert HEAD --no-edit 2>&1; then
    echo "Revert completed successfully."
  else
    echo "ERROR: git revert failed. Manual intervention required." >&2
    exit 2
  fi
fi

exit 1
