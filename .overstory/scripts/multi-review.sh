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
FORCE_LARGE=""
JSON_MODE=false

for arg in "${@:3}"; do
  case "$arg" in
    --large) FORCE_LARGE="--large" ;;
    --json)  JSON_MODE=true ;;
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
  echo "WARNING: Empty diff — no changes detected between ${BASE_BRANCH} and ${FEATURE_BRANCH}" >&2
  if $JSON_MODE; then
    python3 -c "import json; print(json.dumps({'verdict':'PASS','reviews':[]}))"
  else
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

# ── Review prompts ────────────────────────────────────────────────────────────
if $JSON_MODE; then
  REVIEW_PROMPT="You are a senior code reviewer. Review the following git diff carefully.

Respond in EXACTLY this JSON format (no extra prose, no markdown fencing, raw JSON only):
{
  \"verdict\": \"PASS\",
  \"issues\": [
    {
      \"file\": \"path/to/file.ts\",
      \"line\": 42,
      \"severity\": \"error\",
      \"message\": \"description of the issue\",
      \"suggestion\": \"how to fix it\"
    }
  ],
  \"summary\": \"one-line summary of the changes\"
}

verdict must be \"PASS\" or \"FAIL\".
severity must be \"error\", \"warning\", or \"info\".
A FAIL verdict requires at least one issue with a concrete file reference.
issues array must be empty [] for a PASS verdict.
Focus on: correctness, security vulnerabilities, obvious bugs, type safety, and spec compliance.

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
  echo "WARNING: gemini exited with code $GEMINI_EXIT" >&2
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
    CODEX_INSTRUCTIONS="Review the changes on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'. Respond in EXACTLY this JSON format (raw JSON only, no markdown): {\"verdict\":\"PASS\",\"issues\":[{\"file\":\"path\",\"line\":1,\"severity\":\"error\",\"message\":\"desc\",\"suggestion\":\"fix\"}],\"summary\":\"one-line\"}. verdict must be PASS or FAIL. issues empty for PASS. Focus on correctness, security, and type safety."
  else
    CODEX_INSTRUCTIONS="Review the changes introduced on branch '${FEATURE_BRANCH}' relative to '${BASE_BRANCH}'. Report: VERDICT (PASS/FAIL), ISSUES list, one-line SUMMARY. Focus on correctness, security, and type safety."
  fi
  if ! codex review --base "${BASE_BRANCH}" "$CODEX_INSTRUCTIONS" > "$CODEX_OUT" 2>&1; then
    CODEX_EXIT=$?
    echo "WARNING: codex exited with code $CODEX_EXIT" >&2
  fi
  if ! $JSON_MODE; then
    cat "$CODEX_OUT"
    echo ""
  fi
fi

# ── Aggregate verdict ─────────────────────────────────────────────────────────
if $JSON_MODE; then
  # Build aggregate JSON using python3
  python3 - "$GEMINI_OUT" "$CODEX_OUT" "$USE_TRIPLE" <<'PYEOF'
import sys
import json
import re

gemini_path = sys.argv[1]
codex_path  = sys.argv[2]
use_triple  = sys.argv[3].lower() == "true"

def parse_json_review(path, reviewer_name):
    """Parse a JSON review output, falling back to text parsing if needed."""
    try:
        with open(path) as f:
            raw = f.read().strip()
    except Exception:
        return {"reviewer": reviewer_name, "verdict": "FAIL", "issues": [{"file": "unknown", "line": None, "severity": "error", "message": f"Failed to read {reviewer_name} output", "suggestion": "Check reviewer availability"}], "summary": "Review failed"}

    # Try to extract JSON from the output (may have surrounding text)
    json_match = re.search(r'\{[\s\S]*\}', raw)
    if json_match:
        try:
            data = json.loads(json_match.group(0))
            verdict = str(data.get("verdict", "FAIL")).upper()
            if verdict not in ("PASS", "FAIL"):
                verdict = "FAIL"
            issues = data.get("issues", [])
            # Normalize issues
            normalized = []
            for iss in issues:
                if isinstance(iss, dict):
                    normalized.append({
                        "file": str(iss.get("file", "unknown")),
                        "line": iss.get("line"),
                        "severity": str(iss.get("severity", "error")),
                        "message": str(iss.get("message", "")),
                        "suggestion": str(iss.get("suggestion", ""))
                    })
            return {
                "reviewer": reviewer_name,
                "verdict": verdict,
                "issues": normalized,
                "summary": str(data.get("summary", ""))
            }
        except (json.JSONDecodeError, ValueError):
            pass

    # Fallback: parse text format
    verdict = "FAIL"
    verdict_match = re.search(r'VERDICT:\s*(PASS|FAIL)', raw, re.IGNORECASE)
    if verdict_match:
        verdict = verdict_match.group(1).upper()

    summary = ""
    summary_match = re.search(r'SUMMARY:\s*(.+)', raw)
    if summary_match:
        summary = summary_match.group(1).strip()

    issues = []
    if verdict == "FAIL":
        # Extract issue lines
        issues_section = re.search(r'ISSUES:\s*\n([\s\S]*?)(?=SUMMARY:|$)', raw)
        if issues_section:
            for line in issues_section.group(1).splitlines():
                line = line.strip().lstrip('- ').strip()
                if line and line.lower() != 'none':
                    issues.append({
                        "file": "unknown",
                        "line": None,
                        "severity": "error",
                        "message": line,
                        "suggestion": ""
                    })

    return {"reviewer": reviewer_name, "verdict": verdict, "issues": issues, "summary": summary}

reviews = [parse_json_review(gemini_path, "gemini")]
if use_triple:
    reviews.append(parse_json_review(codex_path, "codex"))

overall_verdict = "PASS"
for r in reviews:
    if r["verdict"] != "PASS":
        overall_verdict = "FAIL"
        break

result = {"verdict": overall_verdict, "reviews": reviews}
print(json.dumps(result, indent=2))
PYEOF

  # Exit with appropriate code
  RESULT_VERDICT="$(python3 - "$GEMINI_OUT" "$CODEX_OUT" "$USE_TRIPLE" 2>/dev/null <<'PYEOF'
import sys, json, re

def get_verdict(path):
    try:
        with open(path) as f:
            raw = f.read()
        m = re.search(r'"verdict"\s*:\s*"(PASS|FAIL)"', raw, re.IGNORECASE)
        if m: return m.group(1).upper()
        m = re.search(r'VERDICT:\s*(PASS|FAIL)', raw, re.IGNORECASE)
        if m: return m.group(1).upper()
    except Exception:
        pass
    return "FAIL"

g = get_verdict(sys.argv[1])
use_triple = sys.argv[3].lower() == "true"
overall = g
if use_triple:
    c = get_verdict(sys.argv[2])
    if c != "PASS":
        overall = "FAIL"
print(overall)
PYEOF
  )"

  if [[ "$RESULT_VERDICT" == "PASS" ]]; then
    exit 0
  else
    exit 1
  fi

else
  # Human-readable aggregate
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
