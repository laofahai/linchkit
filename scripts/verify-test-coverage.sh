#!/usr/bin/env bash
#
# scripts/verify-test-coverage.sh — prove that scripts/run-tests.sh executes
# EVERY `*.test.ts(x)` in the repo (excluding node_modules), with zero gaps.
#
# It runs the SAME batch targets as run-tests.sh, collects the set of test-file
# headers Bun actually printed ("path/to/file.test.ts:") across all batches,
# and diffs that union against `find`. A file may be covered by more than one
# batch (overlap is fine); a file covered by NONE is a gap and fails the check.
#
# The known mid-run crash file (lint-capability.test.ts) emits its header
# before it crashes, so it still counts as discovered/executed.
#
# This is a CI-friendly assertion, not part of the gate that runs the tests.
# Run it whenever batch targets or the test-file layout change.

set -uo pipefail

strip_ansi() {
  sed -E 's/\x1b\[[0-9;]*[mGKHJ]//g'
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
EXECUTED="${WORK}/executed.txt"
EXPECTED="${WORK}/expected.txt"
: >"$EXECUTED"

# Ground truth: every test file on disk (paths normalised without leading ./).
find . \( -name '*.test.ts' -o -name '*.test.tsx' \) \
  -not -path '*/node_modules/*' \
  | sed -E 's#^\./##' | sort -u >"$EXPECTED"

# Collect executed headers for one batch into $EXECUTED.
collect() {
  local out
  out="$(bun test "$@" 2>&1 | strip_ansi)"
  # Bun prints `path/file.test.ts:` as a header line for each file it runs.
  printf '%s\n' "$out" \
    | grep -oE '^[A-Za-z0-9_./@-]+\.test\.tsx?:' \
    | sed -E 's/:$//' \
    >>"$EXECUTED"
}

# Files run in isolation by run-tests.sh because they crash Bun mid-run. They
# must be EXCLUDED from the cli-rest batch (their crash would truncate files
# sorted after them) and collected one-by-one — exactly as run-tests.sh does.
QUARANTINE=(
  "packages/cli/__tests__/lint-capability.test.ts"
)

is_quarantined() {
  local needle="$1" q
  for q in "${QUARANTINE[@]}"; do
    [ "$needle" = "$q" ] && return 0
  done
  return 1
}

# Mirror run-tests.sh batch targets exactly.
collect ./packages/core/
collect ./packages/devtools/
collect ./packages/starters/
collect ./e2e/
collect ./addons/

CLI_REST=()
while IFS= read -r f; do
  rel="${f#./}"
  if is_quarantined "$rel"; then
    continue
  fi
  CLI_REST+=("$f")
done < <(find ./packages/cli \( -name '*.test.ts' -o -name '*.test.tsx' \) \
           -not -path '*/node_modules/*' | sort)
if [ "${#CLI_REST[@]}" -gt 0 ]; then
  collect "${CLI_REST[@]}"
fi

# Quarantined files run in isolation; each still prints its header before the
# crash, so it counts as discovered/executed.
for q in "${QUARANTINE[@]}"; do
  if [ -f "$q" ]; then
    collect "./${q}"
  fi
done

sort -u "$EXECUTED" -o "$EXECUTED"

EXPECTED_COUNT="$(wc -l <"$EXPECTED" | tr -d ' ')"
EXECUTED_COUNT="$(wc -l <"$EXECUTED" | tr -d ' ')"

echo "Expected test files (find): ${EXPECTED_COUNT}"
echo "Executed test files (union of batches): ${EXECUTED_COUNT}"

# Files expected but never executed by any batch == coverage gaps.
GAPS="$(comm -23 "$EXPECTED" "$EXECUTED")"
if [ -n "$GAPS" ]; then
  echo "::error::Coverage GAP — these test files are not executed by any batch:"
  printf '%s\n' "$GAPS" | sed 's/^/  - /'
  exit 1
fi

echo "Coverage PROVEN: 0 gaps. Every test file is executed by at least one batch."
