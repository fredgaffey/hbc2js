#!/usr/bin/env bash
# Create a ready-to-test worktree: tools/wt-new.sh <name> [base=main]
# -> ~/hbc2js/wt/<name> on a new branch <name>, with the gitignored inputs the tests
# need symlinked from the main checkout. The list is derived from the main checkout's
# `git status --ignored` (not hardcoded); build output and scratch state are skipped.
set -euo pipefail
name="${1:?usage: tools/wt-new.sh <name> [base]}"
base="${2:-main}"
common="$(git rev-parse --path-format=absolute --git-common-dir)"
main="$(cd "$(dirname "$common")" && pwd)"
root="${HBC2JS_WT_ROOT:-$HOME/hbc2js/wt}"
dest="$root/$name"
[ -e "$dest" ] && { echo "exists: $dest" >&2; exit 1; }
mkdir -p "$root"
git -C "$main" worktree add -b "$name" "$dest" "$base"
# Not linked: dist/ (build output, must be per-worktree), local/ (irreplaceable scratch),
# test-results (per-run), .DS_Store.
skip='^(dist/|local/|ui/test-results/|.*\.DS_Store$)'
n=0
while IFS= read -r p; do
  p="${p%/}"
  [ -e "$main/$p" ] || continue
  mkdir -p "$dest/$(dirname "$p")"
  [ -e "$dest/$p" ] || [ -L "$dest/$p" ] || { ln -s "$main/$p" "$dest/$p"; n=$((n+1)); }
done < <(git -C "$main" status --ignored --short | sed -n 's/^!! //p' | grep -Ev "$skip" || true)
echo "worktree $dest on branch $name (base $base), $n ignored inputs linked from $main"
"$dest/tools/wt-check.sh" || true
