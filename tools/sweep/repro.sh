#!/usr/bin/env bash
# Repro check for a sweep cluster: compile <repro.js> with every fetched
# hermesc (-O), decompile, and run bytecode vs decompiled JS under the same
# Hermes VM (`hbc2js equiv --hbc`).   tools/sweep/repro.sh <repro.js> [versions...]
set -uo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
src=$1; shift; vers=${*:-84 94 96 98 99}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
for v in $vers; do
  hc="$here/tools/hermesc/v$v/hermesc"; [ -x "$hc" ] || { echo "v$v: no hermesc"; continue; }
  "$hc" -O -emit-binary -out "$tmp/v$v.hbc" "$src" 2>"$tmp/c.err" || { echo "v$v: compile failed: $(head -c 200 "$tmp/c.err")"; continue; }
  node "$here/src/cli.ts" "$tmp/v$v.hbc" "$tmp/v$v.js" 2>"$tmp/d.err" || { echo "v$v: decompile failed: $(head -c 200 "$tmp/d.err")"; continue; }
  verdict=$(node "$here/src/cli.ts" equiv --hbc "$tmp/v$v.hbc" "$tmp/v$v.js" 2>&1 | tr '\n' ' ' | cut -c1-260)
  echo "v$v: $verdict"
  [ -n "${REPRO_KEEP:-}" ] && cp "$tmp/v$v.js" "$REPRO_KEEP.v$v.js"
done
