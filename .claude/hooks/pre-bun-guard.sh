#!/bin/bash
# PreToolUse guard for Bash — block real node/npm/npx invocations, NOT substrings.
#
# Background: Claude Code's `if: "Bash(npm *)"` style matchers substring-match the
# whole command string (see pre-commit.sh for the same observation). That made the
# old inline guards fire on innocent commands — a path like `bun ./node_modules/x`,
# a branch name, a commit message, or even a *sibling* command batched in the same
# turn — and a single exit-2 cancels the entire batch.
#
# This script is the precise arbiter: it parses the real command from stdin and
# only blocks when node/npm/npx appears as an actual command boundary:
#   - at the start of the command, OR
#   - right after a shell separator (`;`, `&`, `|`, `(`),
# followed by whitespace or end-of-string. So `node app.ts`, `x && npm i`,
# `$(npx foo)` are blocked, while `bun ./node_modules/.bin/drizzle-kit`,
# `registry.npmmirror.com`, and `feat/some-node-thing` pass through.
#
# Known limitation (shared with pre-commit.sh): single- and double-quoted
# string literals are now stripped before the boundary checks run, so a token
# inside a grep pattern, commit message, or branch name in quotes no longer
# false-blocks. The residual limitation is only nested/escaped quotes (e.g.
# `"a\"b"` or quotes inside quotes), plus prefixes like `sudo node` /
# `env X=1 node` which are not matched. We never use those.

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Strip quoted string literals first, so a token inside a grep pattern,
# commit message, or branch name in quotes cannot trigger a false block.
# (Pure-bash quote tracking is impractical; this handles the common,
#  non-nested case and is a guardrail, not an airtight parser.)
STRIPPED=$(printf '%s' "$COMMAND" | sed "s/'[^']*'//g; s/\"[^\"]*\"//g")

# Returns success when $1 is invoked at a real command boundary.
invoked() {
  printf '%s' "$STRIPPED" | grep -Eq "(^|[;&|(])[[:space:]]*$1([[:space:]]|\$)"
}

if invoked npx; then
  echo "BLOCKED: Use bunx instead of npx." >&2
  exit 2
fi
if invoked npm; then
  echo "BLOCKED: Use bun instead of npm." >&2
  exit 2
fi
if invoked node; then
  echo "BLOCKED: Use bun instead of node." >&2
  exit 2
fi

exit 0
