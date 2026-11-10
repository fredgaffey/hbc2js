#!/usr/bin/env bash
# tools/pkgsig/bulk/slot-reset.sh — sourced by worker.sh. Resets one scaffold
# slot to a private pristine copy before EVERY job: a package install can
# rewrite the slot's node_modules (docs/BUGS.md 2026-11-10 "slot poisoning"),
# and the next job on that slot must not inherit it.
#
# reset_slot <pristine-dir> <slot-dir>
#   Hard-link copy (cp -al; falls back to a full copy where hard links are
#   unavailable). Hard links share inodes, so the lockfiles - which npm
#   rewrites in place - are re-copied as real files; everything else npm
#   replaces by unlink+create, which leaves the pristine copy untouched.
RESET_SLOT_LOCKFILES="package.json package-lock.json node_modules/.package-lock.json"

reset_slot() {
  local pristine="$1" slot="$2" lf
  [ -d "$pristine" ] || return 1
  rm -rf "$slot"
  cp -al "$pristine" "$slot" 2>/dev/null || { rm -rf "$slot"; cp -R "$pristine" "$slot"; } || return 1
  for lf in $RESET_SLOT_LOCKFILES; do
    if [ -f "$pristine/$lf" ]; then rm -f "$slot/$lf"; cp "$pristine/$lf" "$slot/$lf"; fi
  done
}
