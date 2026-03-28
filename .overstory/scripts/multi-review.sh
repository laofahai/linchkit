#!/usr/bin/env bash
# multi-review.sh — Multi-agent code review gate for overstory workflow
# Usage: multi-review.sh <base-branch> <feature-branch> [--large]
# Exit codes: 0 = all pass, 1 = any fail, 2 = error

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <base-branch> <feature-branch> [--large]" >&2
  exit 2
fi

BASE_BRANCH="$1"
FEATURE_BRANCH="$2"
FORCE_LARGE="${3:-}"

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
  echo "WARNING: Empty diff — no changes detected between ${BASE_BRANCH} and ${FEATURE_BRANCH}" >&2
  echo "VERDICT: PASS (no changes)"
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

# ── Review prompt ─────────────────────────────────────────────────────────────
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

# ── Gemini review ─────────────────────────────────────────────────────────────
echo "--- Gemini Review ---"
GEMINI_EXIT=0
if ! gemini -p "$REVIEW_PROMPT" > "$GEMINI_OUT" 2>&1; then
  GEMINI_EXIT=$?
  echo "WARNING: gemini exited with code $GEMINI_EXIT" >&2
fi
cat "$GEMINI_OUT"
echo ""

# ── Codex review (triple mode only) ──────────────────────────────────────────
CODEX_EXIT=0
if $USE_TRIPLE; then
  echo "--- Codex Review ---"
  CODEX_INSTRUCTIONS="Review the changes introduced on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'. Report: VERDICT (PASS/FAIL), ISSUES list, one-line SUMMARY. Focus on correctness, security, and type safety."
  if ! codex review --base "${BASE_BRANCH}" "$CODEX_INSTRUCTIONS" > "$CODEX_OUT" 2>&1; then
    CODEX_EXIT=$?
    echo "WARNING: codex exited with code $CODEX_EXIT" >&2
  fi
  cat "$CODEX_OUT"
  echo ""
fi

# ── Aggregate verdict ─────────────────────────────────────────────────────────
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
