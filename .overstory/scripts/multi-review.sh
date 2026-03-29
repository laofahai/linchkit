#!/usr/bin/env bash
# multi-review.sh — Multi-agent code review gate for overstory workflow
# Usage: multi-review.sh <base-branch> <feature-branch> [--large] [--json]
#                        [--task-id <id>] [--domain <name>] [--context-lines <n>]
# Exit codes: 0 = all pass, 1 = any fail, 2 = error

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <base-branch> <feature-branch> [--large] [--json] [--task-id <id>] [--domain <name>] [--context-lines <n>]" >&2
  exit 2
fi

BASE_BRANCH="$1"
FEATURE_BRANCH="$2"
FORCE_LARGE=""
JSON_MODE=false
TASK_ID=""
DOMAIN_NAME=""
CONTEXT_LINES=20

# Parse flags from remaining args
i=3
while [[ $i -le $# ]]; do
  arg="${!i}"
  case "$arg" in
    --json)         JSON_MODE=true ;;
    --large)        FORCE_LARGE="--large" ;;
    --task-id)
      i=$((i + 1)); TASK_ID="${!i}" ;;
    --domain)
      i=$((i + 1)); DOMAIN_NAME="${!i}" ;;
    --context-lines)
      i=$((i + 1)); CONTEXT_LINES="${!i}" ;;
  esac
  i=$((i + 1))
done

# ── Temp dir with cleanup ─────────────────────────────────────────────────────
TMPDIR_REVIEW="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_REVIEW"' EXIT

GEMINI_OUT="$TMPDIR_REVIEW/gemini.txt"
CODEX_OUT="$TMPDIR_REVIEW/codex.txt"
DIFF_FILE="$TMPDIR_REVIEW/diff.patch"

# ── Get diff (with configurable context lines) ────────────────────────────────
if ! git diff -U"${CONTEXT_LINES}" "${BASE_BRANCH}...${FEATURE_BRANCH}" > "$DIFF_FILE" 2>/dev/null; then
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

# ── Build context sections ────────────────────────────────────────────────────

# Project context: extract Constraints + Principles sections from CLAUDE.md
PROJECT_CONTEXT=""
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [[ -n "$REPO_ROOT" && -f "$REPO_ROOT/CLAUDE.md" ]]; then
  PROJECT_CONTEXT="$(awk '
    /^## (Constraints|Principles)/ { found=1; print; next }
    found && /^## / && !/^## (Constraints|Principles)/ {
      if (in_section) { in_section=0 }
      found=0
    }
    found { in_section=1; print }
  ' "$REPO_ROOT/CLAUDE.md" 2>/dev/null | head -60 || true)"
fi

# Task intent: fetch seeds issue description
TASK_INTENT=""
if [[ -n "$TASK_ID" ]]; then
  TASK_INTENT="$(sd show "$TASK_ID" 2>/dev/null || true)"
fi

# Domain conventions: fetch mulch records for domain
DOMAIN_CONVENTIONS=""
if [[ -n "$DOMAIN_NAME" ]]; then
  DOMAIN_CONVENTIONS="$(mulch search "$DOMAIN_NAME" 2>/dev/null || true)"
fi

# ── Build context preamble ────────────────────────────────────────────────────
build_context_preamble() {
  local preamble=""

  if [[ -n "$PROJECT_CONTEXT" ]]; then
    preamble="${preamble}
--- PROJECT CONTEXT ---
${PROJECT_CONTEXT}
"
  fi

  if [[ -n "$TASK_INTENT" ]]; then
    preamble="${preamble}
--- TASK INTENT ---
${TASK_INTENT}
"
  fi

  if [[ -n "$DOMAIN_CONVENTIONS" ]]; then
    preamble="${preamble}
--- DOMAIN CONVENTIONS (${DOMAIN_NAME}) ---
${DOMAIN_CONVENTIONS}
"
  fi

  echo "$preamble"
}

CONTEXT_PREAMBLE="$(build_context_preamble)"

# ── Review prompt ─────────────────────────────────────────────────────────────
if $JSON_MODE; then
  REVIEW_PROMPT="You are a senior code reviewer. Review the following git diff carefully.
${CONTEXT_PREAMBLE}
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
${CONTEXT_PREAMBLE}
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
    CODEX_INSTRUCTIONS="Review the changes introduced on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'.${CONTEXT_PREAMBLE:+ ${CONTEXT_PREAMBLE}} Respond ONLY with valid JSON: { \"verdict\": \"PASS\" or \"FAIL\", \"issues\": [{\"file\": \"...\", \"line\": 0, \"severity\": \"error\" or \"warning\", \"message\": \"...\", \"suggestion\": \"...\"}], \"summary\": \"...\" }. verdict is FAIL only for error-severity issues."
  else
    CODEX_INSTRUCTIONS="Review the changes introduced on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'.${CONTEXT_PREAMBLE:+ ${CONTEXT_PREAMBLE}} Report: VERDICT (PASS/FAIL), ISSUES list, one-line SUMMARY. Focus on correctness, security, and type safety."
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
