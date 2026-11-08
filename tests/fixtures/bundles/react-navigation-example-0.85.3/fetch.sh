#!/usr/bin/env bash
# Regenerates index.android.bundle, react-navigation-example.hbc and
# react-navigation-example.debug.hbc for this fixture. See BUILD.md for
# expected sizes/hashes and provenance. Not run automatically by anything —
# invoke manually; does its work in a temp dir, never inside the repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning react-navigation/react-navigation into $WORK/rn-nav"
# Pinned: the BUILD.md hashes were made against exactly this commit. Never run
# against upstream HEAD (the repo moves; ids/fn numbers in tests would shift).
PIN=ab1319d6bbf05eae8dc25e33cbf4dc56494e0f0c
git init -q "$WORK/rn-nav"
cd "$WORK/rn-nav"
git remote add origin https://github.com/react-navigation/react-navigation.git
git fetch -q --depth 1 origin "$PIN"
git checkout -q FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$PIN" ] || { echo "pin mismatch" >&2; exit 1; }
echo "==> HEAD: $(git rev-parse HEAD)"

echo "==> pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

cd example
echo "==> expo export (JS bundle, no bytecode, with Metro source map for D17d ground truth)"
node_modules/.bin/expo export --platform android --output-dir dist-js --no-bytecode --source-maps

JSBUNDLE="$(find dist-js -name '*.js' | head -1)"
JSMAP="$(find dist-js -name '*.map' | head -1)"
# Strip the trailing //# sourceMappingURL / //# debugId comments that
# --source-maps appends (debugId is a random UUID per build): BUILD.md's hash is
# of the bundle exported WITHOUT source maps. The original $JSBUNDLE is kept
# untouched for the truth derivation below.
perl -0pe 's{\n//# (?:sourceMappingURL|debugId)=[^\n]*}{}g' "$JSBUNDLE" > "$HERE/index.android.bundle"

echo "==> fetching hermesc v98 (HBC bytecode version for RN 0.85.3)"
"$REPO_ROOT/tools/get-hermesc.sh" 98
HERMESC="$REPO_ROOT/tools/hermesc/v98/hermesc"

# hermesc embeds the input path it was given in the .hbc, so compile from $HERE
# with a bare relative name: output is then independent of where the repo lives.
echo "==> compiling -O"
(cd "$HERE" && "$HERMESC" -O -emit-binary -out=react-navigation-example.hbc index.android.bundle)
echo "==> compiling -O -g"
(cd "$HERE" && "$HERMESC" -O -g -emit-binary -out=react-navigation-example.debug.hbc index.android.bundle)

echo "==> done. sha256 (BUILD.md expects 07b00f6d.../38fdce65.../255c46d8...):"
shasum -a 256 "$HERE/index.android.bundle" "$HERE/react-navigation-example.hbc" "$HERE/react-navigation-example.debug.hbc"

# D17d ground truth (docs/DECISIONS.md D17d, docs/DEPS.md "Ground truth"):
# derive per-module package@version truth from the Metro source map while
# node_modules is still on disk (tools/deps-truth.mjs's truthFromMap reads
# each source's node_modules/<pkg>/package.json for its exact version).
# Run against the *original* dist-js/.map + .js (still sitting next to the
# example project's own node_modules) rather than the copies under $HERE,
# so the map's relative `sources` paths resolve. Neither the map nor
# deps-truth.json is committed (see BUILD.md) — regenerate by re-running
# this script.
if [ -n "$JSMAP" ]; then
  cp "$JSMAP" "$HERE/react-navigation-example.map"
  echo "==> deriving D17d ground truth from the source map"
  node "$REPO_ROOT/tools/deps-truth.mjs" \
    "$HERE/react-navigation-example.hbc" "$JSMAP" \
    --bundle-js "$JSBUNDLE" \
    --write-truth "$HERE/deps-truth.json" \
    --also-hbc "$HERE/react-navigation-example.debug.hbc" \
    --root "$WORK/rn-nav"
else
  echo "WARNING: expo export --source-maps produced no .map file; deps-truth.json not written" >&2
fi
