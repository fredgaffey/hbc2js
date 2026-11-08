#!/usr/bin/env bash
# tools/pkgsig/ship/finalize.sh — one-step finalize of a path DB for release
# (docs/PACKAGE-SIGNATURES.md "Shipping db-v4-paths"). Never publishes; it
# prints the `gh release create` command for the owner.
#
#   SRC=<source pathless db> OUT=<rebuilt db dir> [LIST=<OUT.failed.txt>] \
#   STAGE=<staging dir, must not exist> [TAG=sigdb-v4-YYYYMMDD] [SAMPLE=N] \
#     tools/pkgsig/ship/finalize.sh
#
# Steps: (1) hardlink-copy OUT to STAGE/db, then hardlink the pathless
# originals listed in LIST (default $OUT.failed.txt) from SRC; with SAMPLE=N
# only N files of OUT (+ up to N/10 listed originals) go in, a dry run that
# is never publishable. (2) validate-path-db.mjs on STAGE/db against SRC
# (fails the run on a hard error). (3) import into STAGE/sigdb.sqlite (rev 2)
# with --verify. (4) tar.zst (gzip without zstd) + index json in the
# assemble.sh index format via assemble.sh itself. (5) sha256 + sizes in
# STAGE/dist/SHA256SUMS and the owner command.
# STAGE, OUT and SRC should share a filesystem (hard links). Needs node 22.
set -euo pipefail
: "${SRC:?set SRC}" "${OUT:?set OUT}" "${STAGE:?set STAGE}"
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIST="${LIST:-$OUT.failed.txt}"; TAG="${TAG:-sigdb-v4-$(date -u +%Y%m%d)}"; SAMPLE="${SAMPLE:-0}"
[ -e "$STAGE" ] && { echo "ERROR: $STAGE exists; refusing to reuse" >&2; exit 1; }
if [ "$SAMPLE" = 0 ] && [ -f "$OUT.log" ] && ! grep -q '^[0-9TZ:-]* DONE' "$OUT.log"; then
  echo "ERROR: $OUT.log has no DONE marker: rebuild unfinished (use SAMPLE=N for a dry run)" >&2; exit 1; fi
DB="$STAGE/db"; mkdir -p "$DB" "$STAGE/dist"
lnf() { ln "$1" "$2" 2>/dev/null || cp "$1" "$2"; }
if [ "$SAMPLE" = 0 ]; then
  ( cd "$OUT" && for f in *.json; do lnf "$OUT/$f" "$DB/$f"; done )
  [ -d "$OUT/_baselines" ] && { mkdir -p "$DB/_baselines"; for f in "$OUT"/_baselines/*; do lnf "$f" "$DB/_baselines/$(basename "$f")"; done; }
  np=0; if [ -f "$LIST" ]; then while read -r f; do [ -n "$f" ] && [ ! -e "$DB/$f" ] && { lnf "$SRC/$f" "$DB/$f"; np=$((np+1)); }; done < "$LIST"; fi
else
  ( cd "$OUT" && ls | awk -v n="$SAMPLE" '/\.json$/ && c<n {print; c++}' | while read -r f; do lnf "$OUT/$f" "$DB/$f"; done )
  np=0; if [ -f "$LIST" ]; then while read -r f; do [ -n "$f" ] && { lnf "$SRC/$f" "$DB/$f"; np=$((np+1)); }; done < <(awk -v n=$((SAMPLE/10+1)) 'NR<=n' "$LIST"); fi
  [ -d "$OUT/_baselines" ] && { mkdir -p "$DB/_baselines"; for f in "$OUT"/_baselines/*; do lnf "$f" "$DB/_baselines/$(basename "$f")"; done; }
fi
echo "staged $(ls "$DB" | grep -c '\.json$') files ($np pathless originals linked)"
SRCARG=(); [ "$SAMPLE" = 0 ] && SRCARG=(--src "$SRC")
node "$R/tools/pkgsig/ship/validate-path-db.mjs" "$DB" "${SRCARG[@]}" > "$STAGE/validate.json" || { echo "VALIDATION FAILED, see $STAGE/validate.json" >&2; head -c 2000 "$STAGE/validate.json" >&2; exit 1; }
grep -E '"(files|withPaths|modulePathCoveragePct|functionModuleIdCoveragePct|filesWithPathsPct)"' "$STAGE/validate.json"
# sqlite import + verify. KNOWN GAP (2026-11-09): the sqlite layer does not
# store module.factoryIsDependency / nestedFunctionIndices / subtractedDependencies /
# bulkBuildFixVersion, so --verify reports round-trip mismatches on db-v3-style
# JSON and match.ts (which reads the first two) would score a sqlite copy
# differently. The sqlite asset is therefore built and reported but only
# attached to the release command when verify passes (SQLITE_RELEASE=1 forces it).
SQLITE_OK=0
if node --experimental-strip-types "$R/tools/pkgsig/sigdb/import-json.mjs" "$DB" "$STAGE/sigdb.sqlite" --verify > "$STAGE/import.log" 2>&1; then SQLITE_OK=1; fi
grep -E '"ok"|enumerated|roundtripMismatches' "$STAGE/import.log" || true
[ "$SQLITE_OK" = 1 ] || echo "WARNING: sqlite --verify failed (see $STAGE/import.log); sqlite asset NOT attached to the owner command"
# archive + index via assemble.sh (its db/ dir layout is exactly $DB)
HBC2JS_BULK_DIR="$STAGE" "$R/tools/pkgsig/bulk/assemble.sh" >/dev/null
ARCHIVE="$(ls "$STAGE"/dist/sigdb-*-partial.tar.* | head -1)"; IDX="$STAGE/dist/index-partial.json"
EXT="${ARCHIVE#*sigdb-*-partial}"
FINAL="$STAGE/dist/$TAG$EXT"; mv "$ARCHIVE" "$FINAL"; mv "$IDX" "$STAGE/dist/index-$TAG.json"
rm -f "$STAGE"/dist/index-partial*.json
if [ "$SQLITE_OK" = 1 ] || [ "${SQLITE_RELEASE:-0}" = 1 ]; then
  if command -v zstd >/dev/null; then zstd -q -19 -T0 -o "$STAGE/dist/$TAG.sqlite.zst" "$STAGE/sigdb.sqlite"; else gzip -9 -c "$STAGE/sigdb.sqlite" > "$STAGE/dist/$TAG.sqlite.gz"; fi
fi
( cd "$STAGE/dist" && { sha256sum * 2>/dev/null || shasum -a 256 *; } | grep -v SHA256SUMS > SHA256SUMS; ls -l | awk 'NR>1{print $5, $9}' )
cat "$STAGE/dist/SHA256SUMS"
echo
if [ "$SAMPLE" != 0 ]; then echo "DRY RUN (SAMPLE=$SAMPLE): not publishable. rm -rf $STAGE when done."; exit 0; fi
echo "OWNER COMMAND (run from a machine that can reach $STAGE/dist; this script published nothing):"
echo "gh release create $TAG --repo fredgaffey/hbc2js --title \"Signature DB v4 (module paths)\" --notes-file $STAGE/dist/SHA256SUMS $STAGE/dist/$TAG$EXT $STAGE/dist/index-$TAG.json $(ls "$STAGE"/dist/$TAG.sqlite.* 2>/dev/null | tr '\n' ' ')"
