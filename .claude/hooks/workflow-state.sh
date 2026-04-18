#!/bin/bash
# Workflow state helper — shared by all workflow hooks.
# State file: $TMPDIR/linchkit-wf-<project-id>-<branch-slug>
# Each line: key=timestamp (each marker appears at most once — wf_mark dedupes)
# Freshness refs:
#   <state-file>.<key>.ref   — touch'ed when the marker is set
#   <state-file>.<key>.files — checksum of `git ls-files` at mark time

_wf_file() {
  local branch project_id
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '-')
  # Include project path hash to avoid collisions between repos with same branch name
  project_id=$(printf "%s" "$(git rev-parse --show-toplevel 2>/dev/null)" | cksum | cut -d' ' -f1)
  echo "${TMPDIR:-/tmp}/linchkit-wf-${project_id}-${branch}"
}

wf_has() {
  # Check if a workflow step has been recorded (ignores freshness).
  # Usage: wf_has tests_passed
  # Anchored to line start to prevent "check_passed" matching "typecheck_passed"
  grep -q "^$1=" "$(_wf_file)" 2>/dev/null
}

# _wf_tracked_hash — checksum of the tracked file list. Used by wf_mark /
# wf_fresh to detect additions/removals (including `git rm` or `git mv`)
# that `find -newer` would otherwise miss.
_wf_tracked_hash() {
  git ls-files 2>/dev/null | sort | cksum | cut -d' ' -f1
}

wf_mark() {
  # Record a workflow step as done AND snapshot the current state so wf_fresh
  # can detect any edits, additions, or deletions made after the marker was set.
  # Dedupe: remove any prior entry for this marker before appending. Without
  # this, the state file grows unbounded across successive marks (post-commit
  # no longer resets).
  local wf
  wf=$(_wf_file)
  if [ -f "$wf" ]; then
    grep -v "^$1=" "$wf" > "$wf.tmp" 2>/dev/null || true
    mv "$wf.tmp" "$wf" 2>/dev/null || true
  fi
  echo "$1=$(date +%s)" >> "$wf"
  touch "$wf.$1.ref" 2>/dev/null || true
  _wf_tracked_hash > "$wf.$1.files" 2>/dev/null || true
}

wf_reset() {
  # Clear all workflow state AND its reference / snapshot files.
  local wf
  wf=$(_wf_file)
  > "$wf" 2>/dev/null || true
  rm -f "$wf".*.ref "$wf".*.files 2>/dev/null || true
}

# wf_fresh — marker is present AND nothing relevant changed since it was set.
# Use this instead of wf_has in pre-commit / pre-pr gates so multi-commit
# review-fix flows don't have to re-run gates when nothing changed between
# commits, while still catching real source changes.
#
# Fresh = wf_has <marker> AND .ref exists AND
#   (a) no tracked file has been added/removed since the mark AND
#   (b) nothing under packages/, addons/, apps/, scripts/, .claude/, or the
#       repo-root config files (tsconfig.json, biome.json, package.json,
#       bun.lock, turbo.json, etc.) is newer than the .ref file
#       (node_modules / dist / .bun / .turbo / .next excluded).
#
# Legacy behavior: if the .ref file is missing (older hook state), the marker
# is treated as fresh — keeps upgrade path simple.
wf_fresh() {
  local marker="$1"
  wf_has "$marker" || return 1
  local ref snap wf
  wf=$(_wf_file)
  ref="$wf.${marker}.ref"
  [ -f "$ref" ] || return 0
  snap="$wf.${marker}.files"

  # (a) Tracked file set unchanged? Catches git rm / git add / rename.
  if [ -f "$snap" ]; then
    local current previous
    current=$(_wf_tracked_hash)
    previous=$(cat "$snap" 2>/dev/null)
    [ "$current" = "$previous" ] || return 1
  fi

  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null) || return 0

  # Source directories and root-level config files that affect gates.
  # Array-based so paths with spaces work correctly.
  local paths=()
  for dir in packages addons apps scripts .claude; do
    [ -d "$root/$dir" ] && paths+=("$root/$dir")
  done
  for f in \
    package.json bun.lock bunfig.toml .bunfig.toml \
    tsconfig.json tsconfig.base.json \
    biome.json turbo.json drizzle.config.ts lefthook.yml; do
    [ -f "$root/$f" ] && paths+=("$root/$f")
  done

  [ ${#paths[@]} -eq 0 ] && return 0

  # (b) mtime comparison. -prune excludes heavy dirs; -path prune for nested
  # worktrees so other branches' edits don't invalidate this branch's gates.
  local newer
  newer=$(find "${paths[@]}" \
    \( -name node_modules -o -name dist -o -name .bun -o -name .turbo -o -name .next \) -prune \
    -o -path "$root/.claude/worktrees" -prune \
    -o -type f -newer "$ref" -print 2>/dev/null | head -1)
  [ -z "$newer" ]
}

wf_show() {
  # Display current workflow state.
  local wf
  wf=$(_wf_file)
  if [ -f "$wf" ] && [ -s "$wf" ]; then
    echo "## Workflow Progress"
    cat "$wf"
    echo "---"
  fi
}
