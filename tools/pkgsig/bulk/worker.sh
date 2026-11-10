#!/usr/bin/env bash
# tools/pkgsig/bulk/worker.sh — runs ONE build-one.mjs job, having first
# claimed an exclusive Metro-scaffold "slot" (of HBC2JS_BULK_SLOTS, default
# 16, pre-cloned by run.sh's setup step into
# $HBC2JS_BULK_DIR/slots/{72,87}-<N>) so concurrent jobs never race on the
# same scaffold's node_modules/entry-file/etc. Family 72 (RN 0.72.17)
# serves HBC 94/96; family 87 (RN 0.87.1) serves HBC 98/99 - see
# docs/PACKAGE-SIGNATURES.md §5.5's "recompile identical Metro/Babel output
# with a different hermesc" shortcut for why one scaffold per RN era covers
# two HBC versions each.
#
# Invoked as: worker.sh "<pkg>\t<version>\t<hbcVersion>"  (one line from the
# job list, tab-separated - see run.sh)
set -uo pipefail

BULK_DIR="${HBC2JS_BULK_DIR:-$HOME/hbc2js-bulk}"
REPO_DIR="${HBC2JS_REPO_DIR:-$HOME/hbc2js}"
N="${HBC2JS_BULK_SLOTS:-16}"

LINE="$1"
IFS=$'\t' read -r PKG VER HBC <<< "$LINE"

log_result() {
  local json="$1"
  printf '%s\n' "$json" >> "$BULK_DIR/log/results.jsonl"
}

case "$HBC" in
  94|96) FAMILY=72 ;;
  98|99) FAMILY=87 ;;
  *)
    log_result "{\"package\":\"$PKG\",\"version\":\"$VER\",\"hbcVersion\":\"$HBC\",\"ok\":false,\"reason\":\"unknown hbc version\"}"
    exit 1
    ;;
esac

HERMESC="$REPO_DIR/tools/hermesc/v$HBC/hermesc"

# --- claim a free slot (mkdir-free flock-based semaphore) -----------------
SLOT=""
for i in $(seq 1 "$N"); do
  LOCKFILE="$BULK_DIR/locks/${FAMILY}-${i}.lock"
  exec 200>"$LOCKFILE"
  if flock -n 200; then
    SLOT="$i"
    break
  fi
  exec 200>&-
done

if [ -z "$SLOT" ]; then
  # Should not happen (slot pool size == parallelism), but never drop a job:
  # block on slot 1 rather than fail outright.
  LOCKFILE="$BULK_DIR/locks/${FAMILY}-1.lock"
  exec 200>"$LOCKFILE"
  flock 200
  SLOT=1
fi

SCAFFOLD="$BULK_DIR/slots/${FAMILY}-${SLOT}"

# Per-job slot reset (docs/BUGS.md 2026-11-10 "slot poisoning"): a package
# install can delete scaffold dependencies, and every later job on the slot
# would fail. So each job starts from a hard-link copy of a private pristine
# scaffold ($BULK_DIR/Pristine<family>, made once from ScaffoldRN<family>).
# This replaces the old every-200-uses wipe.
# shellcheck source=slot-reset.sh
. "$(dirname "${BASH_SOURCE[0]}")/slot-reset.sh"
PRISTINE="$BULK_DIR/Pristine${FAMILY}"
if [ ! -d "$PRISTINE" ] && [ -d "$BULK_DIR/ScaffoldRN${FAMILY}" ]; then
  cp -R "$BULK_DIR/ScaffoldRN${FAMILY}" "$PRISTINE.tmp.$$" && mv "$PRISTINE.tmp.$$" "$PRISTINE" 2>/dev/null || rm -rf "$PRISTINE.tmp.$$"
fi
reset_slot "$PRISTINE" "$SCAFFOLD" || echo "$(date -u +%FT%TZ) slot reset FAILED ${FAMILY}-${SLOT}" >> "$BULK_DIR/log/run.log"

OUT="$(node "$REPO_DIR/tools/pkgsig/bulk/build-one.mjs" "$PKG" "$VER" "$HBC" "$SCAFFOLD" "$HERMESC" "$BULK_DIR/db" 2>>"$BULK_DIR/log/${FAMILY}-${SLOT}.err")"
RC=$?

exec 200>&-   # release the slot

if [ -n "$OUT" ]; then
  log_result "$OUT"
else
  log_result "{\"package\":\"$PKG\",\"version\":\"$VER\",\"hbcVersion\":$HBC,\"ok\":false,\"reason\":\"build-one.mjs produced no output (exit $RC)\"}"
fi

exit 0   # never fail the xargs pipeline itself - failures are recorded, not fatal
