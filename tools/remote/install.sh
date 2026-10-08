#!/usr/bin/env bash
# tools/remote/install.sh — deploy the hbc2js-ci job server to any compute node
# (docs/specs/24-compute-node.md §2) as a systemd --user service
# (auto-restart, survives reboot via linger). Generalised from a
# `the remote build node`-specific script: any Debian/Ubuntu box reachable over SSH works.
#
# Usage (from anywhere, on the Mac or the node itself): tools/remote/install.sh [host]
# Default host: the remote build node (ssh alias). Idempotent — safe to re-run to redeploy
# server.mjs after edits.
#
# Does NOT run against a real host as part of this repo's own test/CI —
# this script is only ever invoked by hand against a named node.
set -euo pipefail

HOST="${1:-${HBC2JS_REMOTE_HOST:-}}"
if [ -z "$HOST" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/../../local/remote-host" ]; then
  HOST="$(tr -d '[:space:]' < "$(dirname "${BASH_SOURCE[0]}")/../../local/remote-host")"
fi
if [ -z "$HOST" ]; then echo "no host: pass one, set HBC2JS_REMOTE_HOST, or write it to local/remote-host" >&2; exit 2; fi
REMOTE_DIR='~/hbc2js-ci-bin'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh "$HOST" "mkdir -p $REMOTE_DIR ~/.config/systemd/user"
# server.mjs imports sibling pure modules (pick.mjs, install-check.mjs) by
# relative path -- all of tools/remote/*.mjs must ship together, or the
# service fails at startup with ERR_MODULE_NOT_FOUND (seen 2026-09-29: this
# line used to copy only server.mjs, so adding computeLoadScore/pick.mjs
# and later findBrokenInstalls/install-check.mjs broke every future deploy
# until this was noticed).
scp -q "$SCRIPT_DIR"/*.mjs "$HOST:$REMOTE_DIR/"

# MAX_PARALLEL = nproc / 2, min 1 (spec §2 — default 4 baked into
# server.mjs is sized for the remote build node's 32 cores; every other node needs its own
# value computed on the node itself). server.mjs reads this from the
# MAX_PARALLEL env var (tools/remote/server.mjs line ~28).
MAX_PARALLEL="$(ssh "$HOST" 'n=$(nproc 2>/dev/null || echo 2); half=$((n/2)); if [ "$half" -lt 1 ]; then half=1; fi; echo "$half"')"
echo "MAX_PARALLEL=$MAX_PARALLEL (nproc/2, min 1) on $HOST" >&2

ssh "$HOST" "cat > ~/.config/systemd/user/hbc2js-ci.service" <<UNIT
[Unit]
Description=hbc2js compute-node job server

[Service]
Type=simple
Environment=PATH=%h/.local/share/fnm:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=MAX_PARALLEL=$MAX_PARALLEL
ExecStart=/bin/bash -lc 'export PATH="\$HOME/.local/share/fnm:\$PATH"; exec fnm exec --using 22 -- node %h/hbc2js-ci-bin/server.mjs'
Restart=always
RestartSec=5
WorkingDirectory=%h/hbc2js-ci-bin

[Install]
WantedBy=default.target
UNIT

ssh "$HOST" '
  loginctl enable-linger "$USER" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable hbc2js-ci.service
  systemctl --user restart hbc2js-ci.service
  sleep 1
  systemctl --user --no-pager status hbc2js-ci.service | head -6
'

# Note-only toolchain check (spec §2 "Toolchain" row): warn, never fail —
# jobs on a node missing these just skip oracle-dependent tests
# (docs/TOOLCHAIN.md), they do not error.
if ssh "$HOST" 'test -e ~/hbc2js-dev/tools/hermesc && test -e ~/hbc2js-dev/tools/hermes-vm' 2>/dev/null; then
  echo "Toolchain present: ~/hbc2js-dev/tools/{hermesc,hermes-vm} found on $HOST" >&2
else
  echo "WARNING: ~/hbc2js-dev/tools/{hermesc,hermes-vm} missing on $HOST — oracle-dependent tests will skip on this node until it's fetched (see docs/TOOLCHAIN.md)." >&2
fi

echo "Installed. Try: curl http://$HOST:8787/jobs"
