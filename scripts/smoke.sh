#!/usr/bin/env bash
# dsh-lan-bridge smoke test: negative fence cases, then the end-to-end PONG loop.
#
#   LAN_BRIDGE_URL=http://127.0.0.1:5977 LAN_BRIDGE_TOKEN=lzb_… ./scripts/smoke.sh
#   ./scripts/smoke.sh --unshared <session-id>     # extra args go to `probe e2e`
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
URL=${LAN_BRIDGE_URL:-http://127.0.0.1:5977}
TOKEN=${LAN_BRIDGE_TOKEN:-}

if [ -z "$TOKEN" ]; then
  echo "smoke: LAN_BRIDGE_TOKEN is not set — pair a peer in the panel and export the token" >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || { echo "smoke: node not found on PATH" >&2; exit 2; }

step() {
  label=$1
  shift
  echo "smoke: ${label} (${URL})"
  if ! node "${HERE}/probe.mjs" "$@" --url "$URL" --token "$TOKEN"; then
    echo "smoke: FAIL during ${label} — see probe output above" >&2
    exit 1
  fi
}

step fence fence
step e2e e2e "$@"

echo "smoke: PASS (${URL})"
