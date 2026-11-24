#!/usr/bin/env bash
# tools/get-hermesc.sh — fetch prebuilt `hermesc` (Hermes bytecode compiler) binaries
# for this host, without building Hermes from source and without committing binaries
# to the repo.
#
# Usage:
#   tools/get-hermesc.sh [84|94|96|98|99|all]   (default: all)
#
# Binaries land in tools/hermesc/v<N>/hermesc (gitignored). See docs/TOOLCHAIN.md
# for the version table, provenance, and known caveats (esp. v99 not being
# byte-identical to tests/fixtures/v99.hbc; v98 is only obtainable in the
# "98-late"/class-E header layout from any publicly published package probed
# so far — see docs/HBC-FORMAT.md sec 0.1 and docs/TOOLCHAIN.md).
#
# Requires: npm (to fetch the tarball — no `npm install`, just `npm pack`), tar.
# Works on macOS (Darwin, any arch — the packages ship universal x86_64+arm64
# Mach-O binaries) and Linux x86_64. There is currently no publicly published
# hermesc build for Linux arm64; see docs/TOOLCHAIN.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_ROOT="${HERMESC_OUT_DIR:-$SCRIPT_DIR/hermesc}"

# --- version table -----------------------------------------------------
# hbc_version : npm_package@version : path-to-binary-inside-tarball-per-OS-dir
# The "OS dir" token is substituted with osx-bin / linux64-bin below.
version_84_pkg="hermes-engine-cli@0.8.1"
version_84_bindir="package/OSDIR_TOKEN"

version_94_pkg="react-native@0.72.17"
version_94_bindir="package/sdks/hermesc/OSDIR_TOKEN"

version_96_pkg="react-native@0.73.11"
version_96_bindir="package/sdks/hermesc/OSDIR_TOKEN"

version_98_pkg="hermes-compiler@250829098.0.10"
version_98_bindir="package/hermesc/OSDIR_TOKEN"

version_99_pkg="hermes-compiler@260318099.0.1"
version_99_bindir="package/hermesc/OSDIR_TOKEN"

# --- prebuilt Hermes VMs (the `hermes` CLI, needed by `equiv --boot`) ----
# Checked 2026-11-24, per source, for macOS arm64 and Linux x64:
#   - npm hermes-compiler@* (v98/v99) and react-native@*/sdks/hermesc: hermesc
#     only (react-native@0.73.11's osx-bin alone also carries `hermes`, v96).
#   - Maven com.facebook.hermes:hermes-ios (v98/v99): hermesc, hermes-lit and
#     an embeddable hermesvm.framework; no CLI. hermes-android: Android .so.
#   - facebook/hermes GitHub releases: hermes-cli-{darwin,linux} up to v0.13.0
#     (2024-08-16, classic Hermes, HBC 96); none for static_h (v97+).
# So the one prebuilt VM per OS is v96. Source mode (`equiv --boot`) runs any
# app's JS under any VM (classes/private members are lowered for it), so the
# v96 VM serves every app; a same-version VM for v94/v98/v99 bytecode mode is
# a source build: tools/build-hermes-vm.sh <version>.
vm_96_url_darwin="https://github.com/facebook/hermes/releases/download/v0.13.0/hermes-cli-darwin.tar.gz"
vm_96_sha_darwin="f16b0214f7b96eccbd47766f5a3914e847a4387649b2f6b60820d309879200bd"
vm_96_url_linux="https://github.com/facebook/hermes/releases/download/v0.13.0/hermes-cli-linux.tar.gz"
vm_96_sha_linux="aead6eb0b8f563bb022354352eae32dad96c933330b6c1941b6db17674ca68ae"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch_vm <hbc_version>: make sure $OUT_ROOT/v<N>/hermes exists, or say
# clearly that no prebuilt one does.
fetch_vm() {
  local v="$1" out_dir="$OUT_ROOT/v$1" url sha tmp_dir got
  [ -x "$out_dir/hermes" ] && return 0
  if [ "$v" = "96" ]; then
    case "$(uname -s)" in
      Darwin) url="$vm_96_url_darwin"; sha="$vm_96_sha_darwin" ;;
      Linux)
        if [ "$(uname -m)" = "x86_64" ]; then url="$vm_96_url_linux"; sha="$vm_96_sha_linux"; fi ;;
    esac
    if [ -n "${url:-}" ]; then
      echo "v96: fetching the Hermes VM from $url (sha256-pinned)..."
      tmp_dir="$(mktemp -d)"
      if curl -fsSL -o "$tmp_dir/cli.tar.gz" "$url"; then
        got="$(sha256_of "$tmp_dir/cli.tar.gz")"
        if [ "$got" != "$sha" ]; then
          echo "ERROR: sha256 mismatch for $url (got $got, pinned $sha); not installing it." >&2
          rm -rf "$tmp_dir"; return 1
        fi
        mkdir -p "$out_dir"
        tar xzf "$tmp_dir/cli.tar.gz" -C "$tmp_dir" ./hermes
        cp "$tmp_dir/hermes" "$out_dir/hermes"; chmod +x "$out_dir/hermes"
        rm -rf "$tmp_dir"
        echo "v96: installed hermes ($("$out_dir/hermes" --version 2>&1 | grep -E 'HBC bytecode version' | sed 's/^ *//'))"
        return 0
      fi
      rm -rf "$tmp_dir"
      echo "ERROR: could not download $url" >&2
      return 1
    fi
  fi
  cat >&2 <<NOTE
v${v}: NOTE: no prebuilt Hermes VM (the 'hermes' CLI) exists for HBC v${v} on $(uname -s) $(uname -m).
  Checked: npm hermes-compiler / react-native ship hermesc only; Maven hermes-ios ships an
  embeddable framework, no CLI; facebook/hermes GitHub releases stop at v0.13.0 (HBC 96).
  'equiv --boot' still works: it runs both sides as source under any VM, so run
  'hbc2js setup-vm 96' (macOS, Linux x64). For a same-version VM (bytecode mode, '--hbc'),
  build one: tools/build-hermes-vm.sh ${v}   (see docs/TOOLCHAIN.md)
NOTE
  return 0
}

usage() {
  echo "Usage: $0 [84|94|96|98|99|all]" >&2
  exit 1
}

detect_osdir() {
  case "$(uname -s)" in
    Darwin) echo "osx-bin" ;;
    Linux)
      if [ "$(uname -m)" != "x86_64" ]; then
        echo "WARNING: no published hermesc build for Linux $(uname -m); only linux64 (x86_64) binaries exist upstream. Trying anyway under emulation may work if you have qemu/box64, otherwise this will fail." >&2
      fi
      echo "linux64-bin"
      ;;
    *)
      echo "ERROR: unsupported OS $(uname -s). Only macOS and Linux are supported." >&2
      exit 1
      ;;
  esac
}

fetch_one() {
  local hbc_version="$1" pkgspec="$2" bindir_template="$3"
  local osdir bindir out_dir tmp_dir tarball

  osdir="$(detect_osdir)"
  bindir="${bindir_template//OSDIR_TOKEN/$osdir}"
  out_dir="$OUT_ROOT/v${hbc_version}"

  if [ -x "$out_dir/hermesc" ]; then
    echo "v${hbc_version}: already present at $out_dir/hermesc (skipping; delete it to re-fetch)"
    fetch_vm "$hbc_version"
    return
  fi

  echo "v${hbc_version}: fetching $pkgspec (${osdir})..."
  tmp_dir="$(mktemp -d)"

  ( cd "$tmp_dir" && npm pack "$pkgspec" --silent >/dev/null )
  tarball="$(ls "$tmp_dir"/*.tgz | head -1)"
  if [ -z "$tarball" ]; then
    echo "ERROR: npm pack produced no tarball for $pkgspec" >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  mkdir -p "$out_dir"

  # Extract every binary that lives alongside hermesc in this package's bin dir
  # (hermes-engine-cli also ships hbcdump/hdb/hermes, which are handy for
  # disassembly and are documented in docs/TOOLCHAIN.md).
  local extracted=0
  for f in "$bindir/hermesc" "$bindir/hbcdump" "$bindir/hdb" "$bindir/hermes" "$bindir/hermes-lit"; do
    if tar tzf "$tarball" "$f" >/dev/null 2>&1; then
      tar xzf "$tarball" -C "$tmp_dir" "$f"
      cp "$tmp_dir/$f" "$out_dir/$(basename "$f")"
      chmod +x "$out_dir/$(basename "$f")"
      extracted=$((extracted + 1))
    fi
  done

  if [ "$extracted" -eq 0 ]; then
    echo "ERROR: could not find $bindir/hermesc inside $pkgspec's tarball. The package layout may have changed — check docs/TOOLCHAIN.md and update this script's *_bindir variable." >&2
    rm -rf "$tmp_dir"
    return 1
  fi

  rm -rf "$tmp_dir"
  echo "v${hbc_version}: installed $(ls "$out_dir")"
  "$out_dir/hermesc" --version 2>&1 | grep -E 'HBC bytecode version|Hermes release version' | sed 's/^/  /'
  fetch_vm "$hbc_version"
}

main() {
  local requested="${1:-all}"
  case "$requested" in
    84) fetch_one 84 "$version_84_pkg" "$version_84_bindir" ;;
    94) fetch_one 94 "$version_94_pkg" "$version_94_bindir" ;;
    96) fetch_one 96 "$version_96_pkg" "$version_96_bindir" ;;
    98) fetch_one 98 "$version_98_pkg" "$version_98_bindir" ;;
    99) fetch_one 99 "$version_99_pkg" "$version_99_bindir" ;;
    all)
      fetch_one 84 "$version_84_pkg" "$version_84_bindir"
      fetch_one 94 "$version_94_pkg" "$version_94_bindir"
      fetch_one 96 "$version_96_pkg" "$version_96_bindir"
      fetch_one 98 "$version_98_pkg" "$version_98_bindir"
      fetch_one 99 "$version_99_pkg" "$version_99_bindir"
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
}

main "$@"
