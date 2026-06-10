#!/usr/bin/env bash
#
# Real-browser e2e smoke runner.
#
# - Reuses already-running dev servers when both the UI and the API answer
#   their health probes; otherwise boots `bun run dev:server` / `bun run
#   dev:ui` in the background and tears down ONLY the processes it started.
# - Runs the gated browser suite with LINCHKIT_E2E_BROWSER=1 and propagates
#   the bun test exit code.
#
# Env knobs:
#   LINCHKIT_E2E_UI_URL   (default http://localhost:3000)
#   LINCHKIT_E2E_API_URL  (default http://localhost:3001)
#   LINCHKIT_CHROME_PATH  (browser binary override; see e2e/browser/helpers)
#   LINCHKIT_E2E_AI=1        opt-in: AI assistant reachability test
#   LINCHKIT_E2E_EVOLUTION=0 opt-out: evolution run-cycle test

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_URL="${LINCHKIT_E2E_UI_URL:-http://localhost:3000}"
API_URL="${LINCHKIT_E2E_API_URL:-http://localhost:3001}"
BOOT_TIMEOUT_SECS=90
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/linchkit-e2e.XXXXXX")"

started_pids=()

# Kill a process and all of its descendants (bun run spawns child processes).
kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  local pid
  for pid in "${started_pids[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "[e2e] stopping process tree $pid"
      kill_tree "$pid"
    fi
  done
}
trap cleanup EXIT

api_healthy() {
  curl -fsS -m 3 "$API_URL/health" >/dev/null 2>&1
}

ui_healthy() {
  curl -fsS -m 3 "$UI_URL/" >/dev/null 2>&1
}

wait_for() {
  local label="$1" check_fn="$2" waited=0
  while ! "$check_fn"; do
    if [ "$waited" -ge "$BOOT_TIMEOUT_SECS" ]; then
      echo "[e2e] ERROR: $label did not become ready within ${BOOT_TIMEOUT_SECS}s" >&2
      echo "[e2e] logs (if started by this script): $LOG_DIR" >&2
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "[e2e] $label is ready"
}

if api_healthy; then
  echo "[e2e] reusing running API server at $API_URL"
else
  echo "[e2e] starting dev:server (log: $LOG_DIR/server.log)"
  (cd "$ROOT_DIR" && bun run dev:server >"$LOG_DIR/server.log" 2>&1) &
  started_pids+=("$!")
fi

if ui_healthy; then
  echo "[e2e] reusing running UI at $UI_URL"
else
  echo "[e2e] starting dev:ui (log: $LOG_DIR/ui.log)"
  (cd "$ROOT_DIR" && bun run dev:ui >"$LOG_DIR/ui.log" 2>&1) &
  started_pids+=("$!")
fi

wait_for "API ($API_URL/health)" api_healthy
wait_for "UI ($UI_URL/)" ui_healthy

echo "[e2e] running browser smoke suite"
set +e
(cd "$ROOT_DIR" && LINCHKIT_E2E_BROWSER=1 bun test ./e2e/browser/ --timeout 120000)
status=$?
set -e

exit "$status"
