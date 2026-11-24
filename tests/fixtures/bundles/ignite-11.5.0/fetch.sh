#!/usr/bin/env bash
# Regenerates app.hbc (+ deps-truth.json) for this fixture. See BUILD.md.
# Manual only; works in a temp dir, never inside the repo. Needs git, node 24, network.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PIN=a0464bf1337099eb3bb7cbdef54fbcd0ccf94859
git init -q "$WORK/ignite"
cd "$WORK/ignite"
git remote add origin https://github.com/infinitered/ignite.git
git fetch -q --depth 1 origin "$PIN"
git checkout -q FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$PIN" ] || { echo "pin mismatch" >&2; exit 1; }
cd boilerplate
npm install --legacy-peer-deps --ignore-scripts --no-audit --no-fund
export CI=1 EXPO_NO_TELEMETRY=1
node_modules/.bin/expo export --platform android --output-dir dist-hbc
cp dist-hbc/_expo/static/js/android/index-*.hbc "$HERE/app.hbc"
node -e 'const p=require("./package.json");require("fs").writeFileSync(process.argv[1],JSON.stringify({dependencies:p.dependencies},null,2))' "$HERE/deps-truth.json"
echo "wrote $HERE/app.hbc"
