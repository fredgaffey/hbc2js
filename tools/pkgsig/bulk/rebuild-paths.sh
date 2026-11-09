#!/usr/bin/env bash
# tools/pkgsig/bulk/rebuild-paths.sh — rebuild a whole signature DB with
# module paths v1 (docs/PACKAGE-SIGNATURES.md §7 "Rebuilding a DB with
# paths"). Transplants paths onto every file of SRC into OUT, one Metro
# bundle per package@version per RN family (transplant-multi.mjs). Resumable:
# re-run it; files already in OUT are skipped (so
# a job that logged NOSLOT after SLOT_TIMEOUT is retried by the re-run).
#
#   SRC=<db dir> OUT=<new db dir> SCAFFOLDS=<dir holding ScaffoldRN87, ScaffoldRN72> \
#     [R=<repo>] [WORK=<OUT>-work] [LOG=<OUT>.log] [MIN_FREE_GB=8] rebuild-paths.sh [SLOTS=26]
#
# OUT, WORK and SRC should share a filesystem (the finish step hard-links).
# Needs: node 22 on PATH, flock (util-linux; on macOS `brew install flock`), the hermesc builds under $R/tools/hermesc.
set -u
: "${SRC:?set SRC}" "${OUT:?set OUT}" "${SCAFFOLDS:?set SCAFFOLDS}"
export R=${R:-$(cd "$(dirname "$0")/../../.." && pwd)}
export SRC OUT SCAFFOLDS WORK=${WORK:-$OUT-work} LOG=${LOG:-$OUT.log}
export MIN_FREE_KB=$(( ${MIN_FREE_GB:-8} * 1024 * 1024 )) N=${1:-26}
TOOL=${TOOL:-$R/tools/pkgsig/bulk/transplant-multi.mjs}; export TOOL # TOOL: override (tests use a stub)
export SLOT_TIMEOUT=${SLOT_TIMEOUT:-7200} SLOT_POLL=${SLOT_POLL:-1}
mkdir -p "$OUT" "$WORK/slots" "$WORK/locks"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
free_kb() { df -Pk "$WORK" | awk 'NR==2{print $4}'; }
export -f log free_kb
job() { # args: family pkgver files...
  local fam=$1 pv=$2; shift 2
  while [ "$(free_kb)" -lt "$MIN_FREE_KB" ]; do log "PAUSE low disk $(free_kb)KB"; sleep 60; done
  # Wait for a free slot: sweep all slots, sleep, sweep again, until
  # SLOT_TIMEOUT. The node child gets fd 200 closed (200>&-): lingering
  # Metro/hermesc workers that outlive a job would otherwise inherit the
  # lock and keep the slot "busy" after the job ended (the NOSLOT cause). A job must never give up just because every slot is
  # momentarily held (slots == xargs -P makes that routine).
  local deadline=$(( $(date +%s) + SLOT_TIMEOUT ))
  while :; do
  for i in $(seq 1 "$N"); do exec 200>"$WORK/locks/$fam-$i.lock"; if flock -n 200; then
    local S=$WORK/slots/$fam-$i C=$WORK/locks/$fam-$i.count n
    n=$(cat "$C" 2>/dev/null || echo 0)
    # a fresh scaffold copy every 150 jobs: npm uninstall leaves residue
    if [ ! -d "$S" ] || [ "$n" -ge 150 ]; then rm -rf "$S"; cp -r "$SCAFFOLDS/ScaffoldRN$fam" "$S"; n=0; fi
    echo $((n+1)) > "$C"
    local todo=("$@") res f
    for attempt in 1 2; do
      res=$(node --experimental-strip-types "$TOOL" "$S" "$SRC" "$OUT" "${todo[@]}" 2>>"$WORK/err-$fam-$i.log" 200>&-)
      echo "$res" | sed "s/^/RESULT /" >> "$LOG"
      todo=(); for f in "$@"; do [ -f "$OUT/$f" ] || { echo "$res" | grep -q "\"file\":\"$f\".*too many unmatched" || todo+=("$f"); }; done
      [ ${#todo[@]} -eq 0 ] && break
    done
    return; fi; exec 200>&-; done
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "$SLOT_POLL"
  done
  # Timed out: the files stay out of OUT, so the next run's --plan retries them.
  log "NOSLOT $pv (timeout ${SLOT_TIMEOUT}s; retried on re-run)"
}
export -f job
node "$TOOL" --plan "$SRC" "$OUT" > "$WORK/jobs.txt"
log "$(wc -l < "$WORK/jobs.txt") jobs"
for fam in 87 72; do
  grep "^$fam " "$WORK/jobs.txt" > "$WORK/jobs-$fam.txt"
  log "family $fam: $(wc -l < "$WORK/jobs-$fam.txt") jobs"
  xargs -P "$N" -L1 bash -c 'job "$@"' _ < "$WORK/jobs-$fam.txt"
  rm -rf "$WORK/slots/$fam-"*
done
# Files that got no paths (bundle failure, dependency drift): listed, not
# linked; link the pathless originals in when the DB is to be complete:
#   while read f; do ln "$SRC/$f" "$OUT/$f"; done < "$OUT.failed.txt"
( cd "$SRC" && for f in *.json; do [ -f "$OUT/$f" ] || echo "$f"; done ) > "$OUT.failed.txt"
log "failed/pathless: $(wc -l < "$OUT.failed.txt") (in $OUT.failed.txt)"
log "DONE"
