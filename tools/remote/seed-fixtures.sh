#!/usr/bin/env bash
# tools/remote/seed-fixtures.sh — copy this checkout's gitignored, already-
# fetched fixture bundle artifacts (tests/fixtures/bundles/**) into a
# compute node's fixture cache (docs/REMOTE-CI.md "Fixture cache"), so a
# fresh ephemeral job worktree there gets the same fixtures a Mac dev
# checkout has, without ever committing them to git and without copying
# them into the job worktree by hand.
#
# Run BY HAND on a machine that already has the fixture(s) fetched (that
# fixture's own fetch.sh, run once) -- never invoked by an agent or by this
# repo's own tests/CI, same rule as install.sh. Safe to re-run: it only
# rsyncs whatever this checkout's git currently reports as ignored under
# tests/fixtures/bundles/, so re-running after a fixture is re-fetched (or
# a new fixture gains a fetch.sh) picks up the change with no edits here.
#
# Usage: tools/remote/seed-fixtures.sh [host]   (default host: the remote build node)
set -euo pipefail

HOST="${1:-${HBC2JS_REMOTE_HOST:-}}"
if [ -z "$HOST" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/../../local/remote-host" ]; then
  HOST="$(tr -d '[:space:]' < "$(dirname "${BASH_SOURCE[0]}")/../../local/remote-host")"
fi
if [ -z "$HOST" ]; then echo "no host: pass one, set HBC2JS_REMOTE_HOST, or write it to local/remote-host" >&2; exit 2; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Resolve $HOME on the remote side to an absolute path up front, rather
# than passing a literal "~" through quoted ssh/rsync arguments -- quoting
# a tilde suppresses its expansion and silently creates a wrongly-named
# "~" directory instead of resolving it (hit this exact bug while testing).
REMOTE_HOME="$(ssh "$HOST" 'echo $HOME')"
REMOTE_DIR="$REMOTE_HOME/hbc2js-ci/fixture-cache"

cd "$REPO_ROOT"

# Only the gitignored (never-committed) files under tests/fixtures/bundles/
# -- the tracked files (BUILD.md, fetch.sh, licence.txt, ...) already exist
# in every worktree via git and don't need seeding; some fixtures (e.g.
# rn-template-0.72) are fully tracked and need no seeding at all, so this
# naturally seeds nothing for them.
# mapfile is bash-4+ only; macOS ships bash 3.2, so build the array with a
# portable read loop instead (CLAUDE.md: must work on macOS and Linux).
files=()
while IFS= read -r line; do
  files+=("$line")
done < <(git status --porcelain --ignored=matching -- tests/fixtures/bundles | awk '{print $2}')

if [ "${#files[@]}" -eq 0 ]; then
  echo "No gitignored fixture files found under tests/fixtures/bundles/ in this checkout ($REPO_ROOT) -- nothing to seed. Run each fixture's own fetch.sh first (e.g. tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)." >&2
  exit 1
fi

ssh "$HOST" "mkdir -p $REMOTE_DIR"
total_bytes=0
for f in "${files[@]}"; do
  ssh "$HOST" "mkdir -p \"\$(dirname \"$REMOTE_DIR/$f\")\""
  rsync -az "$f" "$HOST:$REMOTE_DIR/$f"
  bytes="$(wc -c < "$f")"
  total_bytes=$((total_bytes + bytes))
  echo "seeded $f ($bytes bytes)" >&2
done

echo "Done. $HOST's fixture-cache now has ${#files[@]} file(s) (~$((total_bytes / 1024 / 1024)) MB) under $REMOTE_DIR/. No restart needed -- server.mjs reads the cache fresh on every job." >&2
