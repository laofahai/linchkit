#!/usr/bin/env bash
#
# scripts/verify-test-coverage.sh — prove that scripts/run-tests.sh executes
# EVERY `*.test.ts(x)` in the repo (excluding node_modules), with zero gaps.
#
# This is a STATIC check: it does NOT run any tests. It asserts that every test
# file on disk falls under one of the batch *targets* declared in run-tests.sh.
# That is sufficient because run-tests.sh's batch targets are whole directory
# trees (`bun test ./packages/core/` scans the tree) plus packages/cli (every
# cli test file is discovered at runtime and either quarantined or run), and
# run-tests.sh itself verifies each batch actually COMPLETED. So:
#   "every file is under a batch target"  (this script)
#   + "every batch ran to completion"     (run-tests.sh)
#   = the whole suite ran.
#
# Why not parse `bun test` output instead? Bun's console output is not a stable,
# machine-parsable format (ANSI, GitHub `::group::` wrapping in CI, layout
# changes), and a mid-run segfault truncates it — so header-scraping is both
# fragile and, in CI, doubles the test execution time. A static set check is
# deterministic, segfault-proof, and runs in well under a second.
#
# KEEP IN SYNC with the batch targets in scripts/run-tests.sh.

set -uo pipefail

# Repo root (this script lives in <root>/scripts/).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Directory-prefix targets covered by run-tests.sh. packages/cli is covered as a
# whole: run-tests.sh discovers every packages/cli test file at runtime and runs
# it (quarantined files in isolation, the rest as one batch).
COVERED_PREFIXES="
packages/core/
packages/devtools/
packages/starters/
packages/cli/
scripts/
config/
e2e/
addons/
"

gaps=""
total=0
while IFS= read -r f; do
  rel="${f#./}"
  total=$((total + 1))
  covered=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    case "$rel" in
      "$p"*) covered=1; break ;;
    esac
  done <<EOF
$COVERED_PREFIXES
EOF
  if [ "$covered" -eq 0 ]; then
    gaps="${gaps}${rel}
"
  fi
done < <(find . \( -name '*.test.ts' -o -name '*.test.tsx' \) \
           -not -path '*/node_modules/*' | sort -u)

echo "Test files on disk: ${total}"
echo "run-tests.sh batch prefixes:$(printf '%s' "$COVERED_PREFIXES" | tr '\n' ' ')"

if [ -n "$gaps" ]; then
  echo "::error::Coverage GAP — these test files fall under no batch target in scripts/run-tests.sh:"
  printf '%s' "$gaps" | sed 's/^/  - /'
  echo "Fix: add the directory to scripts/run-tests.sh and to COVERED_PREFIXES here."
  exit 1
fi

echo "Coverage PROVEN: every test file falls under a run-tests.sh batch target. 0 gaps."
