#!/usr/bin/env bash
#
# scripts/run-tests.sh — the canonical full test runner for LinchKit.
#
# WHY THIS EXISTS
# ---------------
# A single root `bun test` does NOT run the whole suite. Bun 1.2.18 hits a
# runtime crash (panic 0x4A) MID-RUN, deterministically, while executing
# `packages/cli/__tests__/lint-capability.test.ts`. Run order puts `packages/`
# first and `addons/` last, so the crash lands BEFORE `addons/` is ever
# reached: in CI, 0 of the 177 addons test files ran. The old CI guard masked
# the non-zero exit as success whenever a `(pass)` line was present and no
# `(fail)` line was — which is exactly how a TRUNCATED run snuck through green.
#
# This runner instead executes the suite as a set of smaller batches, each of
# which is verified to actually COMPLETE (print its "Ran N tests across M
# files" summary). The known crash file is QUARANTINED and run in isolation
# with an explicit, loudly-logged allowance — never a blanket pass.
#
# HONEST GATE CONTRACT
# --------------------
# For every batch:
#   * Any `(fail)` line              -> the batch FAILED (a real test failed).
#   * Exit 0                          -> the batch PASSED.
#   * Exit != 0 WITH a completion
#     summary and no `(fail)` line    -> PASSED (benign post-summary teardown
#                                        segfault; the batch fully ran).
#   * Exit != 0 WITHOUT a completion
#     summary                         -> TRUNCATED -> the batch FAILED, UNLESS
#                                        the batch is a single quarantined file,
#                                        in which case it is allowed with a
#                                        WARNING printed to the log.
#
# A truncated, non-quarantined batch can no longer pass silently: the whole
# run exits non-zero and the CI job goes RED.
#
# COVERAGE
# --------
# The union of the batch targets provably covers every `*.test.ts(x)` in the
# repo (excluding node_modules). `scripts/verify-test-coverage.sh` proves this
# by diffing the union of executed file headers against `find`.
#
# Bun positional-arg semantics (verified on 1.2.18):
#   * A directory path ending in `/` (e.g. `./addons/`) is SCANNED as a tree.
#   * A bare word (e.g. `addons`) is a FILENAME SUBSTRING FILTER — do NOT use.
#   * Explicit file paths run exactly those files.
# This runner only ever passes directory paths or explicit file paths, never
# bare substring words, so targeting is unambiguous.

set -uo pipefail

# Strip ANSI escapes so summary/`(fail)` detection is reliable in CI logs.
# Inject a literal ESC via printf — `\x1b` is a GNU-sed extension unsupported by
# BSD sed (the default on macOS), so this stays portable across both.
strip_ansi() {
  local esc
  esc="$(printf '\033')"
  sed -E "s/${esc}\[[0-9;]*[mGKHJ]//g"
}

# Files known to trigger the Bun mid-run segfault. Each is run in isolation and
# allowed to crash WITHOUT a completion summary, with a loud warning. This is a
# narrow, explicit, audited allowance — NOT a blanket pass. Keep this list
# minimal; re-test and remove entries whenever the Bun runtime is upgraded.
QUARANTINE=(
  # lint-capability.test.ts was quarantined here because test 2 called
  # lintCapabilityCommand.run() in-process, triggering a Bun GC/teardown defect
  # (panic 0x4A). Fixed in #434: test 2 now uses Bun.spawn subprocess isolation,
  # matching the pattern already used by test 3. Entry removed.
)

is_quarantined() {
  local needle="$1" q
  for q in ${QUARANTINE[@]+"${QUARANTINE[@]}"}; do
    [ "$needle" = "$q" ] && return 0
  done
  return 1
}

# Aggregate exit status across all batches. Non-zero => the job goes red.
OVERALL_RC=0

# run_batch <label> <target...> — run one `bun test` invocation and apply the
# honest-gate contract above. `quarantine_single=1` (env) marks a single-file
# quarantined batch that is allowed to crash without a summary.
run_batch() {
  local label="$1"
  shift
  local quarantine_single="${quarantine_single:-0}"

  echo "::group::bun test — ${label}"
  # Stream output live (tee) instead of buffering it in a variable, so a
  # long/E2E batch never looks hung and CI shows progress in real time. Capture
  # Bun's own exit status via PIPESTATUS[0] (NOT the pipeline's, which pipefail
  # would skew toward tee).
  local tmp rc clean
  tmp="$(mktemp)"
  bun test "$@" 2>&1 | tee "$tmp"
  rc="${PIPESTATUS[0]}"
  clean="$(strip_ansi <"$tmp")"
  rm -f "$tmp"

  # A real test failure is fatal regardless of exit code.
  if grep -qE '^\(fail\)' <<<"$clean"; then
    echo "::error::[${label}] contains failing tests."
    OVERALL_RC=1
    echo "::endgroup::"
    return
  fi

  if [ "$rc" -eq 0 ]; then
    echo "[${label}] PASS (clean exit)."
    echo "::endgroup::"
    return
  fi

  # Non-zero exit, no `(fail)` line. Did the batch actually finish?
  if grep -qE '^Ran [0-9]+ tests across [0-9]+ files?\.' <<<"$clean"; then
    echo "::warning::[${label}] exited ${rc} but printed its completion summary with no (fail) lines — benign Bun post-summary teardown segfault (panic 0x4A). Counting as PASS."
    echo "::endgroup::"
    return
  fi

  # Truncated: non-zero exit and NO completion summary.
  if [ "$quarantine_single" -eq 1 ]; then
    echo "::warning::[${label}] is QUARANTINED: it crashes Bun mid-run (panic 0x4A) WITHOUT a completion summary. Allowed with an explicit, logged allowance. Re-test on the next Bun upgrade and remove from QUARANTINE when fixed."
    echo "::endgroup::"
    return
  fi

  echo "::error::[${label}] exited ${rc} WITHOUT a completion summary and is NOT quarantined — the batch was TRUNCATED (crashed mid-run). Tests did not finish; failing the job."
  OVERALL_RC=1
  echo "::endgroup::"
}

# -- Batches ---------------------------------------------------------------
# Directory-path batches (scanned as trees). Each is verified to complete.
run_batch "packages/core"     ./packages/core/
run_batch "packages/devtools" ./packages/devtools/
run_batch "packages/starters" ./packages/starters/
run_batch "e2e"               ./e2e/
run_batch "addons"            ./addons/

# packages/cli is split: the crash file is quarantined and the rest run as one
# batch of explicit file paths. The file list is DISCOVERED at runtime so newly
# added cli tests are covered automatically (no hardcoded list to drift).
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
  run_batch "packages/cli (minus quarantine)" "${CLI_REST[@]}"
else
  echo "::error::No non-quarantined packages/cli test files discovered — coverage gap."
  OVERALL_RC=1
fi

# Quarantined files, each run in isolation with an explicit logged allowance.
for q in ${QUARANTINE[@]+"${QUARANTINE[@]}"}; do
  if [ -f "$q" ]; then
    quarantine_single=1 run_batch "QUARANTINE ${q}" "./${q}"
  else
    echo "::warning::Quarantined path '${q}' no longer exists — remove it from QUARANTINE."
  fi
done

if [ "$OVERALL_RC" -eq 0 ]; then
  echo "All test batches completed (or were explicitly quarantined). PASS."
else
  echo "One or more test batches FAILED or were TRUNCATED. See ::error:: lines above."
fi
exit "$OVERALL_RC"
