#!/usr/bin/env bash
# Report gitignored inputs present in the main checkout but missing here.
# Exit 1 if any are missing. Run from any worktree.
set -uo pipefail
here="$(git rev-parse --show-toplevel)"
common="$(git rev-parse --path-format=absolute --git-common-dir)"
main="$(cd "$(dirname "$common")" && pwd)"
if [ "$here" = "$main" ]; then echo "main checkout: nothing to check"; exit 0; fi
skip='^(dist/|local/|ui/test-results/|.*\.DS_Store$)'
miss=0
while IFS= read -r p; do
  p="${p%/}"
  [ -e "$main/$p" ] || continue
  if [ ! -e "$here/$p" ]; then echo "MISSING: $p  (ln -s $main/$p $here/$p)"; miss=1; fi
done < <(git -C "$main" status --ignored --short | sed -n 's/^!! //p' | grep -Ev "$skip")
[ $miss = 0 ] && echo "wt-check: all ignored inputs present" || echo "wt-check: run tools/wt-new.sh-style links for the above"
exit $miss
