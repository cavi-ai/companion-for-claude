#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux || ! -f /.dockerenv ]]; then
  echo "The Obsidian e2e runner requires an isolated Linux container." >&2
  exit 1
fi

mkdir -p "$CC_E2E_OUTPUT_DIR"
Xvfb "$DISPLAY" -screen 0 1600x1000x24 -nolisten tcp > "$CC_E2E_OUTPUT_DIR/xvfb.log" 2>&1 &
xvfb_pid=$!

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if ! node e2e/rig/cli.ts stop > "$CC_E2E_OUTPUT_DIR/rig-stop.log" 2>&1; then
    if [[ $status == 0 ]]; then status=1; fi
  fi
  if [[ -f "$CC_E2E_ROOT/obsidian-launch.log" ]]; then
    if ! cp "$CC_E2E_ROOT/obsidian-launch.log" "$CC_E2E_OUTPUT_DIR/obsidian-launch.log"; then status=1; fi
  fi
  kill "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for attempt in {1..50}; do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then
    cat "$CC_E2E_OUTPUT_DIR/xvfb.log" >&2
    exit 1
  fi
  sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null

if [[ $# -gt 0 ]]; then
  "$@"
else
  pnpm run test:e2e
fi
