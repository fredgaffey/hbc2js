#!/usr/bin/env bash
# Regenerates index.android.bundle, index.android.bundle.map, expensify-app.hbc and expensify-app.debug.hbc
# for this fixture. See BUILD.md for expected sizes/hashes/provenance and for
# the worklets retry-loop workaround this script bakes in. Not run
# automatically by anything — invoke manually; does its work in a temp dir,
# never inside the repo.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> fetching Expensify/App @ pinned commit (shallow, into $WORK/expensify)"
PIN_SHA=12a92bd39f31ddabf5a425552930cbb055536555
mkdir "$WORK/expensify"
git -C "$WORK/expensify" init -q
git -C "$WORK/expensify" fetch -q --depth 1 https://github.com/Expensify/App.git "$PIN_SHA"
git -C "$WORK/expensify" checkout -q FETCH_HEAD
cd "$WORK/expensify"
echo "==> HEAD: $(git rev-parse HEAD)"

echo "==> npm ci (npm 11.12.1, engine-strict off; see BUILD.md 'J3 recipe')"
npm_config_engine_strict=false npx -y npm@11.12.1 ci --ignore-scripts

# react-native-worklets writes .worklets/<id>.js mid-transform; without a
# watcher Metro can throw "Failed to get the SHA-1" on the first runs. Each
# failed run leaves more files on disk, so retry (watchman not required).
echo "==> react-native bundle (--max-workers 1, retry loop; see BUILD.md)"
ok=0
for n in 1 2 3 4 5 6; do
  if npx react-native bundle \
      --platform android --dev false --entry-file index.js \
      --bundle-output "$HERE/index.android.bundle" \
      --sourcemap-output "$HERE/index.android.bundle.map" \
      --assets-dest "$WORK/release-assets" --max-workers 1; then ok=1; break; fi
  echo "==> bundle attempt $n failed, retrying"
done
[ "$ok" = 1 ] || { echo "ERROR: react-native bundle failed 6 times" >&2; exit 1; }

# hermesc matching the app's own pin (hermes-compiler 250829098.0.14, HBC 98)
case "$(uname -s)" in
  Darwin) HERMESC="$WORK/expensify/node_modules/hermes-compiler/hermesc/osx-bin/hermesc" ;;
  *)      HERMESC="$WORK/expensify/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc" ;;
esac
if ! "$HERMESC" -version >/dev/null 2>&1; then
  echo "==> app hermesc unusable here; falling back to tools/get-hermesc.sh 98"
  "$REPO_ROOT/tools/get-hermesc.sh" 98
  HERMESC="$REPO_ROOT/tools/hermesc/v98/hermesc"
fi

echo "==> compiling -O"
"$HERMESC" -O -emit-binary -out="$HERE/expensify-app.hbc" "$HERE/index.android.bundle"
echo "==> compiling -O -g"
"$HERMESC" -O -g -emit-binary -out="$HERE/expensify-app.debug.hbc" "$HERE/index.android.bundle"

echo "==> done. sha256:"
shasum -a 256 "$HERE/index.android.bundle" "$HERE/expensify-app.hbc" "$HERE/expensify-app.debug.hbc"
PIN="$(node -e 'console.log(Object.values(require(process.argv[1]).hbcSha256s).join(" "))' "$HERE/deps-truth.json")"
GOT="$(shasum -a 256 "$HERE/expensify-app.hbc" | cut -d' ' -f1)"
case " $PIN " in
  *" $GOT "*) echo "==> expensify-app.hbc matches the deps-truth.json pin" ;;
  *) echo "==> NOTE: expensify-app.hbc ($GOT) differs from the deps-truth.json pin ($PIN)." \
          "The bundle is not byte-reproducible (BUILD.md); deps scoring will report a sha mismatch." ;;
esac
