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

# Isolate test state — point TMPDIR at a scratch dir so wf_reset / wf_mark
# don't clobber the developer's real workflow markers. Also track temp files
# created during the test so a trap can clean them up on any exit path.
SMOKE_TMP=$(mktemp -d)
export TMPDIR="$SMOKE_TMP"
TMP_VICTIM=""
cleanup() {
  rm -rf "$SMOKE_TMP"
  if [ -n "$TMP_VICTIM" ]; then
    git reset -q -- "$TMP_VICTIM" 2>/dev/null || true
    rm -f "$TMP_VICTIM"
  fi
}
trap cleanup EXIT INT TERM

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

# Issue #291: branch guard — block commits on main/master. The guard must run
# BEFORE gate-freshness, so even with all gates fresh it must still block.
# We shadow `git` via a PATH stub that overrides `git rev-parse --abbrev-ref
# HEAD` only and forwards every other invocation to the real git binary.
STUB_DIR="$SMOKE_TMP/git-stub"
mkdir -p "$STUB_DIR"
REAL_GIT=$(command -v git)
cat > "$STUB_DIR/git" <<STUB
#!/bin/bash
if [ "\$1" = "rev-parse" ] && [ "\$2" = "--abbrev-ref" ] && [ "\$3" = "HEAD" ] && [ -n "\${FAKE_BRANCH:-}" ]; then
  echo "\$FAKE_BRANCH"
  exit 0
fi
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$STUB_DIR/git"

STUBBED_PATH="$STUB_DIR:$PATH"

run_with_branch() {
  # $1 = fake branch name, $2 = command for make_input.
  # Use a tempfile so we don't have to escape JSON through nested bash -c.
  local input_file="$SMOKE_TMP/hook-input.json"
  make_input "$2" > "$input_file"
  FAKE_BRANCH="$1" PATH="$STUBBED_PATH" "$HOOKS/pre-commit.sh" < "$input_file" 2>&1
}

mark_gates_for_branch() {
  # Mark fresh QG state under a fake branch so wf_fresh sees gates as fresh
  # when the hook resolves _wf_file with the same fake branch.
  FAKE_BRANCH="$1" PATH="$STUBBED_PATH" bash -c "
    source '$HOOKS/workflow-state.sh'
    wf_reset
    wf_mark check_passed
    wf_mark typecheck_passed
    wf_mark tests_passed
  "
}

wf_reset
mark_gates_for_branch main
unset rc
out=$(run_with_branch main "git commit -m msg") || rc=$? ; rc=${rc:-0}
check "branch=main with fresh gates → exit 2" "[ \"$rc\" = 2 ]"
check "branch=main message mentions BLOCKED" "printf '%s' \"\$out\" | grep -q BLOCKED"
check "branch=main message mentions worktree" "printf '%s' \"\$out\" | grep -q 'git worktree add'"

mark_gates_for_branch master
unset rc
out=$(run_with_branch master "git commit -m msg") || rc=$? ; rc=${rc:-0}
check "branch=master with fresh gates → exit 2" "[ \"$rc\" = 2 ]"
check "branch=master message mentions BLOCKED" "printf '%s' \"\$out\" | grep -q BLOCKED"

mark_gates_for_branch feat/foo
unset rc
out=$(run_with_branch feat/foo "git commit -m msg") || rc=$? ; rc=${rc:-0}
check "branch=feat/foo with fresh gates → exit 0 (falls through)" "[ \"$rc\" = 0 ]"

# And on a feature branch with NO gates: must still hit the gate-freshness
# block (proves the branch guard didn't short-circuit non-main paths).
FAKE_BRANCH=feat/foo PATH="$STUBBED_PATH" bash -c "source '$HOOKS/workflow-state.sh'; wf_reset"
unset rc
out=$(run_with_branch feat/foo "git commit -m msg") || rc=$? ; rc=${rc:-0}
check "branch=feat/foo no gates → exit 2 (gate-freshness still runs)" "[ \"$rc\" = 2 ]"
check "branch=feat/foo no gates → BLOCKED for gates" "printf '%s' \"\$out\" | grep -q 'Quality gates'"

# Reset back to real branch state for downstream tests.
wf_reset

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
TMP_VICTIM="docs/_v_smoke.txt"
echo "bye" > "$TMP_VICTIM"
git add "$TMP_VICTIM" 2>/dev/null
sleep 1
wf_mark check_passed
wf_mark typecheck_passed
wf_mark tests_passed
unset rc
out=$(make_input "git commit -m msg" | "$HOOKS/pre-commit.sh" 2>&1) || rc=$? ; rc=${rc:-0}
check "baseline with staged file → exit 0" "[ \"$rc\" = 0 ]"
git rm -qf "$TMP_VICTIM" 2>/dev/null
rm -f "$TMP_VICTIM"
TMP_VICTIM=""  # already cleaned; unset so trap doesn't retry
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
echo "== pre-bun-guard.sh =="
# Feed fixture JSON to the bun-guard via stdin and assert the exit code.
# 0 = allowed, 2 = blocked. Fixtures live INSIDE this file so the active guard
# on the developer's own shell never inspects (and blocks) the trigger tokens.
bun_guard_rc() {
  # $1 = command string. Echoes the guard's exit code.
  local rc
  make_input "$1" | bash "$HOOKS/pre-bun-guard.sh" >/dev/null 2>&1 && rc=0 || rc=$?
  printf '%s' "$rc"
}

# SHOULD BLOCK (exit 2) — real unquoted node/npm/npx invocations.
check "npm install → blocked"            "[ \"\$(bun_guard_rc 'npm install')\" = 2 ]"
check "npx create-foo → blocked"         "[ \"\$(bun_guard_rc 'npx create-foo')\" = 2 ]"
check "node server.ts → blocked"         "[ \"\$(bun_guard_rc 'node server.ts')\" = 2 ]"
check "x && npm i → blocked"             "[ \"\$(bun_guard_rc 'x && npm i')\" = 2 ]"
check "a; node b → blocked"              "[ \"\$(bun_guard_rc 'a; node b')\" = 2 ]"
check "echo hi | npx cowsay → blocked"   "[ \"\$(bun_guard_rc 'echo hi | npx cowsay')\" = 2 ]"
check "\$(npx z) → blocked"               "[ \"\$(bun_guard_rc '\$(npx z)')\" = 2 ]"

# SHOULD ALLOW (exit 0) — bun usage, mirror URL, branch names, and the
# two false-positive bugs this fix targets (tokens inside quoted literals).
check "bun drizzle-kit → allowed"        "[ \"\$(bun_guard_rc 'bun ./node_modules/.bin/drizzle-kit push')\" = 0 ]"
check "npmmirror URL → allowed"          "[ \"\$(bun_guard_rc 'curl https://registry.npmmirror.com/foo')\" = 0 ]"
check "branch w/ node in name → allowed" "[ \"\$(bun_guard_rc 'git checkout feat/some-node-feature')\" = 0 ]"
check "quoted grep pattern → allowed (BUG)"   "[ \"\$(bun_guard_rc 'grep -nE \"checkout -b|npx foo\" file')\" = 0 ]"
check "quoted commit msg → allowed (BUG)"     "[ \"\$(bun_guard_rc 'git commit -m \"refactor; node bootstrap\"')\" = 0 ]"
check "multi-line quoted commit msg → allowed" "[ \"\$(bun_guard_rc 'git commit -m \"
node bootstrap\"')\" = 0 ]"
check "backtick cmd substitution → blocked"   "[ \"\$(bun_guard_rc 'echo \`node -v\`')\" = 2 ]"
check "bun run check → allowed"          "[ \"\$(bun_guard_rc 'bun run check')\" = 0 ]"

echo
echo "== summary =="
echo "pass: $pass"
echo "fail: $fail"
[ "$fail" -eq 0 ]
