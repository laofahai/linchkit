#!/bin/bash
# Smoke tests for the workflow hooks. Run from repo root:
#   bash .claude/hooks/__tests__/smoke.sh
#
# Covers:
#   1. wf_fresh freshness semantics (marker + ref file + source mtime)
#   2. pre-commit.sh stdin parsing — no-op when command isn't really git commit
#   3. pre-commit.sh — blocks when gates missing; allows when fresh; blocks when stale
#   4. pre-pr.sh stdin parsing — no-op when command isn't really gh pr create
#   5. pre-pr.sh — blocks without cross_model_review, allows with it
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

HOOKS="$ROOT/.claude/hooks"
# shellcheck source=../workflow-state.sh
source "$HOOKS/workflow-state.sh"

pass=0
fail=0
check() {
  if eval "$2"; then
    echo "  ok   $1"
    pass=$((pass + 1))
  else
    echo "  FAIL $1"
    fail=$((fail + 1))
  fi
}

make_input() {
  # Build the stdin JSON the Claude Code harness sends to PreToolUse Bash hooks.
  # $1 = command string
  printf '{"tool_input":{"command":%s}}' "$(jq -Rn --arg c "$1" '$c')"
}

WF=$(_wf_file)

echo "== wf_fresh =="
wf_reset
wf_mark check_passed
check "mark sets wf_has" "wf_has check_passed"
check "ref file created" "[ -f \"$WF.check_passed.ref\" ]"
check "files snapshot created" "[ -f \"$WF.check_passed.files\" ]"
check "fresh right after mark" "wf_fresh check_passed"

# Gemini review: wf_mark must dedupe — calling it twice yields exactly one entry.
wf_mark check_passed
wf_mark check_passed
entries=$(grep -c "^check_passed=" "$WF" 2>/dev/null || echo 0)
check "wf_mark dedupes entries" "[ \"$entries\" = 1 ]"

sleep 1
touch .claude/hooks/workflow-state.sh
check "stale after source edit" "! wf_fresh check_passed"

wf_mark check_passed
check "fresh again after re-mark" "wf_fresh check_passed"

wf_reset
check "reset empties state file" "[ ! -s \"$WF\" ]"
check "reset removes ref file" "[ ! -f \"$WF.check_passed.ref\" ]"

echo
echo "== pre-commit.sh =="
wf_reset

out=$(make_input "echo example-unrelated-cmd body" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "unrelated command → exit 0" "[ \"$rc\" = 0 ]"

unset rc
# Regression: #182 original — hook must NOT fire when 'git commit' appears
# only inside a quoted argument (no shell separator before it).
out=$(make_input "gh issue create --body 'see git commit later'" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "quoted 'git commit' in body → exit 0" "[ \"$rc\" = 0 ]"

unset rc
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "real commit, no gates → exit 2" "[ \"$rc\" = 2 ]"
check "error mentions BLOCKED" "printf '%s' \"\$out\" | grep -q BLOCKED"

unset rc
# Codex P1 regression: wrapped `cd /x && git commit` must enforce gates.
out=$(make_input "cd /tmp && git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "wrapped cd-then-commit → exit 2" "[ \"$rc\" = 2 ]"

unset rc
out=$(make_input "git add . && git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "wrapped add-then-commit → exit 2" "[ \"$rc\" = 2 ]"

# Gemini review: trailing shell separators must match too.
unset rc
out=$(make_input "git commit;make test" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "commit-then-semicolon → exit 2" "[ \"$rc\" = 2 ]"

unset rc
out=$(make_input "git commit&&echo done" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "commit-then-&& → exit 2" "[ \"$rc\" = 2 ]"

unset rc
wf_mark check_passed
wf_mark typecheck_passed
wf_mark tests_passed
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "all gates fresh → exit 0" "[ \"$rc\" = 0 ]"

unset rc
out=$(make_input "cd /tmp && git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "wrapped commit with fresh gates → exit 0" "[ \"$rc\" = 0 ]"

unset rc
sleep 1
touch .claude/hooks/post-quality-gate.sh  # simulate source edit
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "stale gate after edit → exit 2" "[ \"$rc\" = 2 ]"
check "stale message mentions 'stale'" "printf '%s' \"\$out\" | grep -qi stale"

# Codex P1 regression: root config edit must stale the gate.
wf_reset
wf_mark check_passed
wf_mark typecheck_passed
wf_mark tests_passed
sleep 1
touch tsconfig.json
unset rc
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "root tsconfig edit stales gate → exit 2" "[ \"$rc\" = 2 ]"
# Revert mtime so rest of test doesn't cascade
touch -t "$(date -r "$(_wf_file).check_passed.ref" +%Y%m%d%H%M.%S)" tsconfig.json 2>/dev/null || true

# Codex P2 regression: deleting a tracked file must stale the gate.
# Use docs/ (outside the mtime-watched roots) so only the tracked-hash check
# fires — and sleep 1s to guarantee file mtime < ref mtime on fast runs.
wf_reset
tmp_victim="docs/_v_smoke.txt"
echo "bye" > "$tmp_victim"
git add "$tmp_victim" 2>/dev/null
sleep 1
wf_mark check_passed
wf_mark typecheck_passed
wf_mark tests_passed
unset rc
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "baseline with staged file → exit 0" "[ \"$rc\" = 0 ]"
git rm -qf "$tmp_victim" 2>/dev/null
rm -f "$tmp_victim"
unset rc
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "tracked-file removal stales gate → exit 2" "[ \"$rc\" = 2 ]"

wf_reset

echo
echo "== pre-pr.sh =="
unset rc
out=$(make_input "echo some-other-action --body 'xyz'" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "non-matching command → exit 0" "[ \"$rc\" = 0 ]"

unset rc
out=$(make_input "gh issue create --body 'mentions gh pr create later'" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "quoted 'gh pr create' in body → exit 0" "[ \"$rc\" = 0 ]"

unset rc
out=$(make_input "gh pr create --title x" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "no review marker → exit 2" "[ \"$rc\" = 2 ]"

unset rc
out=$(make_input "cd /tmp && gh pr create --title x" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "wrapped cd-then-gh-pr-create → exit 2" "[ \"$rc\" = 2 ]"

# Gemini review: trailing shell separators must match too.
unset rc
out=$(make_input "gh pr create;echo done" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "gh-pr-create-then-semicolon → exit 2" "[ \"$rc\" = 2 ]"

unset rc
out=$(make_input "gh pr create&&echo ok" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "gh-pr-create-then-&& → exit 2" "[ \"$rc\" = 2 ]"

unset rc
wf_mark cross_model_review
out=$(make_input "gh pr create --title x" | "$HOOKS/pre-pr.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "with review marker → exit 0" "[ \"$rc\" = 0 ]"

wf_reset

echo
echo "== post-commit.sh =="
# post-commit should no-op on non-matching commands.
unset rc
out=$(make_input "echo a string" | "$HOOKS/post-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "post-commit no-op on non-match" "[ \"$rc\" = 0 ]"

# And should NOT wipe QG markers anymore.
wf_mark check_passed
wf_mark typecheck_passed
wf_mark tests_passed
wf_mark cross_model_review
unset rc
out=$(make_input "git commit -m msg" | "$HOOKS/post-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "post-commit keeps check_passed" "wf_has check_passed"
check "post-commit keeps tests_passed" "wf_has tests_passed"
check "post-commit keeps cross_model_review" "wf_has cross_model_review"

wf_reset

echo
echo "== summary =="
echo "pass: $pass"
echo "fail: $fail"
[ "$fail" -eq 0 ]
