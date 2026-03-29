#!/usr/bin/env bash
# multi-review.sh — Multi-agent code review gate for overstory workflow
# Usage: multi-review.sh <base-branch> <feature-branch> [--large] [--json]
# Exit codes: 0 = all pass, 1 = any fail, 2 = error

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <base-branch> <feature-branch> [--large] [--json]" >&2
  exit 2
fi

BASE_BRANCH="$1"
FEATURE_BRANCH="$2"
FORCE_LARGE="${3:-}"
JSON_MODE=false

# Parse flags from remaining args
for arg in "${@:3}"; do
  case "$arg" in
    --json)   JSON_MODE=true ;;
    --large)  FORCE_LARGE="--large" ;;
  esac
done

# ── Temp dir with cleanup ─────────────────────────────────────────────────────
TMPDIR_REVIEW="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_REVIEW"' EXIT

GEMINI_OUT="$TMPDIR_REVIEW/gemini.txt"
CODEX_OUT="$TMPDIR_REVIEW/codex.txt"
DIFF_FILE="$TMPDIR_REVIEW/diff.patch"

# ── Get diff ──────────────────────────────────────────────────────────────────
if ! git diff "${BASE_BRANCH}...${FEATURE_BRANCH}" > "$DIFF_FILE" 2>/dev/null; then
  echo "ERROR: Failed to compute diff between ${BASE_BRANCH} and ${FEATURE_BRANCH}" >&2
  exit 2
fi

DIFF_CONTENT="$(cat "$DIFF_FILE")"
if [[ -z "$DIFF_CONTENT" ]]; then
  if $JSON_MODE; then
    echo '{"verdict":"PASS","reviews":[],"summary":"No changes detected"}'
  else
    echo "WARNING: Empty diff — no changes detected between ${BASE_BRANCH} and ${FEATURE_BRANCH}" >&2
    echo "VERDICT: PASS (no changes)"
  fi
  exit 0
fi

# ── Size detection ────────────────────────────────────────────────────────────
FILE_COUNT="$(git diff --name-only "${BASE_BRANCH}...${FEATURE_BRANCH}" | wc -l | tr -d ' ')"
LINE_COUNT="$(echo "$DIFF_CONTENT" | wc -l | tr -d ' ')"

USE_TRIPLE=false
if [[ "$FORCE_LARGE" == "--large" ]]; then
  USE_TRIPLE=true
elif [[ "$FILE_COUNT" -gt 5 || "$LINE_COUNT" -gt 200 ]]; then
  USE_TRIPLE=true
fi

if ! $JSON_MODE; then
  echo "=== Multi-Agent Review Pipeline ==="
  echo "Base:    ${BASE_BRANCH}"
  echo "Feature: ${FEATURE_BRANCH}"
  echo "Files changed: ${FILE_COUNT} | Lines in diff: ${LINE_COUNT}"
  if $USE_TRIPLE; then
    echo "Mode: TRIPLE (Gemini + Codex)"
  else
    echo "Mode: DUAL (Gemini only)"
  fi
  echo ""
fi

# ── Review prompt ─────────────────────────────────────────────────────────────
if $JSON_MODE; then
  REVIEW_PROMPT="You are a senior code reviewer. Review the following git diff carefully.

Respond in EXACTLY this JSON format (no extra prose, valid JSON only):
{
  \"verdict\": \"PASS\" or \"FAIL\",
  \"issues\": [
    {
      \"file\": \"path/to/file.ts\",
      \"line\": 42,
      \"severity\": \"error\" or \"warning\",
      \"message\": \"description of the issue\",
      \"suggestion\": \"how to fix it\"
    }
  ],
  \"summary\": \"one-line summary of the changes\"
}

Rules:
- verdict is FAIL only if there is at least one concrete, actionable issue with severity \"error\"
- warnings alone do not cause FAIL
- If no issues, return empty issues array
- line number should be the +line in the diff if available, otherwise omit or set to 0
- Focus on: correctness, security vulnerabilities, obvious bugs, type safety

--- BEGIN DIFF ---
${DIFF_CONTENT}
--- END DIFF ---"
else
  REVIEW_PROMPT="You are a senior code reviewer. Review the following git diff carefully.

Respond in EXACTLY this format (no extra prose):
VERDICT: PASS or FAIL
ISSUES:
- <issue 1 if any, or 'None'>
- <issue 2 if any>
SUMMARY: <one-line summary of the changes>

Focus on: correctness, security vulnerabilities, obvious bugs, type safety, and spec compliance.
A FAIL verdict requires at least one concrete, actionable issue.

--- BEGIN DIFF ---
${DIFF_CONTENT}
--- END DIFF ---"
fi

# ── Gemini review ─────────────────────────────────────────────────────────────
if ! $JSON_MODE; then
  echo "--- Gemini Review ---"
fi
GEMINI_EXIT=0
if ! gemini -p "$REVIEW_PROMPT" > "$GEMINI_OUT" 2>&1; then
  GEMINI_EXIT=$?
  if ! $JSON_MODE; then
    echo "WARNING: gemini exited with code $GEMINI_EXIT" >&2
  fi
fi
if ! $JSON_MODE; then
  cat "$GEMINI_OUT"
  echo ""
fi

# ── Codex review (triple mode only) ──────────────────────────────────────────
CODEX_EXIT=0
if $USE_TRIPLE; then
  if ! $JSON_MODE; then
    echo "--- Codex Review ---"
  fi
  if $JSON_MODE; then
    CODEX_INSTRUCTIONS="Review the changes introduced on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'. Respond ONLY with valid JSON: { \"verdict\": \"PASS\" or \"FAIL\", \"issues\": [{\"file\": \"...\", \"line\": 0, \"severity\": \"error\" or \"warning\", \"message\": \"...\", \"suggestion\": \"...\"}], \"summary\": \"...\" }. verdict is FAIL only for error-severity issues."
  else
    CODEX_INSTRUCTIONS="Review the changes introduced on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'. Report: VERDICT (PASS/FAIL), ISSUES list, one-line SUMMARY. Focus on correctness, security, and type safety."
  fi
  if ! codex review --base "${BASE_BRANCH}" "$CODEX_INSTRUCTIONS" > "$CODEX_OUT" 2>&1; then
    CODEX_EXIT=$?
    if ! $JSON_MODE; then
      echo "WARNING: codex exited with code $CODEX_EXIT" >&2
    fi
  fi
  if ! $JSON_MODE; then
    cat "$CODEX_OUT"
    echo ""
  fi
fi

# ── Aggregate verdict ─────────────────────────────────────────────────────────
if $JSON_MODE; then
  # Parse JSON output from reviewers
  # Extract verdict and issues from Gemini output
  GEMINI_RAW="$(cat "$GEMINI_OUT")"
  # Strip markdown code fences if present
  GEMINI_JSON="$(echo "$GEMINI_RAW" | sed 's/^```json//;s/^```//' | sed '/^```/d' | tr -d '\r')"
  GEMINI_VERDICT_JSON="$(echo "$GEMINI_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('verdict','UNKNOWN').upper())
except:
    print('UNKNOWN')
" 2>/dev/null || echo "UNKNOWN")"
  GEMINI_ISSUES_JSON="$(echo "$GEMINI_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(json.dumps(data.get('issues',[])))
except:
    print('[]')
" 2>/dev/null || echo "[]")"
  GEMINI_SUMMARY_JSON="$(echo "$GEMINI_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('summary',''))
except:
    print('')
" 2>/dev/null || echo "")"

  OVERALL_PASS=true
  if [[ "$GEMINI_VERDICT_JSON" != "PASS" ]]; then
    OVERALL_PASS=false
  fi

  REVIEWS_JSON="[{\"reviewer\":\"gemini\",\"verdict\":\"${GEMINI_VERDICT_JSON}\",\"issues\":${GEMINI_ISSUES_JSON},\"summary\":$(echo "$GEMINI_SUMMARY_JSON" | python3 -c "import sys,json;print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null || echo '""')}]"

  if $USE_TRIPLE && [[ -f "$CODEX_OUT" ]]; then
    CODEX_RAW="$(cat "$CODEX_OUT")"
    CODEX_JSON_RAW="$(echo "$CODEX_RAW" | sed 's/^```json//;s/^```//' | sed '/^```/d' | tr -d '\r')"
    CODEX_VERDICT_JSON="$(echo "$CODEX_JSON_RAW" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('verdict','UNKNOWN').upper())
except:
    print('UNKNOWN')
" 2>/dev/null || echo "UNKNOWN")"
    CODEX_ISSUES_JSON="$(echo "$CODEX_JSON_RAW" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(json.dumps(data.get('issues',[])))
except:
    print('[]')
" 2>/dev/null || echo "[]")"
    CODEX_SUMMARY_JSON="$(echo "$CODEX_JSON_RAW" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('summary',''))
except:
    print('')
" 2>/dev/null || echo "")"

    if [[ "$CODEX_VERDICT_JSON" != "PASS" ]]; then
      OVERALL_PASS=false
    fi

    CODEX_REVIEW="{\"reviewer\":\"codex\",\"verdict\":\"${CODEX_VERDICT_JSON}\",\"issues\":${CODEX_ISSUES_JSON},\"summary\":$(echo "$CODEX_SUMMARY_JSON" | python3 -c "import sys,json;print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null || echo '""')}"
    # Append codex review to array
    REVIEWS_JSON="$(echo "$REVIEWS_JSON" | python3 -c "
import sys, json
reviews = json.load(sys.stdin)
codex = json.loads('''${CODEX_REVIEW}''')
reviews.append(codex)
print(json.dumps(reviews))
" 2>/dev/null || echo "$REVIEWS_JSON")"
  fi

  if $OVERALL_PASS; then
    FINAL_VERDICT="PASS"
  else
    FINAL_VERDICT="FAIL"
  fi

  python3 -c "
import json
reviews = json.loads('''${REVIEWS_JSON}''')
# Collect all issues
all_issues = []
for r in reviews:
    all_issues.extend(r.get('issues', []))
result = {
    'verdict': '${FINAL_VERDICT}',
    'reviews': reviews,
    'all_issues': all_issues,
    'summary': reviews[0].get('summary','') if reviews else ''
}
print(json.dumps(result, indent=2))
" 2>/dev/null || echo "{\"verdict\":\"${FINAL_VERDICT}\",\"reviews\":[],\"all_issues\":[],\"summary\":\"\"}"

  if $OVERALL_PASS; then
    exit 0
  else
    exit 1
  fi
else
  # ── Text mode aggregate verdict ───────────────────────────────────────────
  echo "=== Aggregate Verdict ==="

  OVERALL_PASS=true

  GEMINI_VERDICT="$(grep -i '^VERDICT:' "$GEMINI_OUT" | head -1 | sed 's/VERDICT:[[:space:]]*//' | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
  if [[ "$GEMINI_VERDICT" != "PASS" ]]; then
    echo "Gemini: FAIL"
    OVERALL_PASS=false
  else
    echo "Gemini: PASS"
  fi

  if $USE_TRIPLE; then
    CODEX_VERDICT="$(grep -i '^VERDICT:' "$CODEX_OUT" | head -1 | sed 's/VERDICT:[[:space:]]*//' | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
    if [[ "$CODEX_VERDICT" != "PASS" ]]; then
      echo "Codex:  FAIL"
      OVERALL_PASS=false
    else
      echo "Codex:  PASS"
    fi
  fi

  echo ""
  if $OVERALL_PASS; then
    echo "PIPELINE VERDICT: PASS"
    exit 0
  else
    echo "PIPELINE VERDICT: FAIL"
    exit 1
  fi
fi
