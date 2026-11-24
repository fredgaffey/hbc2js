#!/usr/bin/env bash
# One app through the whole sweep: static checks, module-factory differential,
# bulk import into the shared findings DB (tools/findings.mjs).
#   tools/sweep/run-app.sh <label> <app.hbc> <outdir> [original-bundle.js|-] [workers] [host-from.js...]
# HBC2JS_FINDINGS_DB picks the DB (default: next to tools/findings.mjs).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
label=$1; hbc=$2; out=$3; orig=${4:--}; workers=${5:-1}; shift 5 || shift $#
hosts=(); for h in "$@"; do hosts+=(--host-from "$h"); done
[ "$orig" != "-" ] && hosts+=(--host-from "$orig")
mkdir -p "$out"
node --max-old-space-size=${SWEEP_HEAP_MB:-12000} "$here/static.ts" "$hbc" --out "$out" --app "$label" --workers "$workers" "${hosts[@]}" > "$out/static.log" 2>&1
ver=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).hbc)' "$out/summary.json")
a=(); [ "$orig" != "-" ] && a=(--a "$orig")
node --max-old-space-size=${SWEEP_HEAP_MB:-12000} "$here/factory-diff.mjs" "${a[@]}" --b "$out/decompiled.js" --out "$out" --app "$label" --hbc "$ver" --calls > "$out/factory.log" 2>&1 || echo "factory-diff failed: see $out/factory.log"
if [ "${SWEEP_NO_DB:-}" != 1 ]; then
  node "$here/../findings.mjs" clear --source sweep --app "$label"
  # W_* warnings stay in findings.jsonl + summary.json histogram, not the shared DB
  grep -v "\"check\":\"WARN\"" "$out/findings.jsonl" > "$out/findings.db.jsonl" || true
  node "$here/../findings.mjs" import "$out/findings.db.jsonl" --source sweep
  [ -s "$out/factory-findings.jsonl" ] && node "$here/../findings.mjs" import "$out/factory-findings.jsonl" --source sweep
fi
echo "$label done: $(cat "$out/summary.json" | tr -d '\n' | cut -c1-400)"
