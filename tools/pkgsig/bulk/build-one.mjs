#!/usr/bin/env node
// tools/pkgsig/bulk/build-one.mjs — D17c bulk signature build: builds ONE
// package@version's signature file for ONE HBC bytecode version, and writes
// it straight into the shared-format DB (docs/PACKAGE-SIGNATURES.md §5.3,
// schema 2) at $HBC2JS_BULK_DB (default ~/hbc2js-bulk/db).
//
// Fetch -> Metro bundle -> hermesc -> fingerprintModule, reusing src/deps's
// *exported* library functions
// (parseHbc/decodeFunction/fingerprintModule/writeSignature) so the on-disk
// format matches `hbc2js deps --confirm`'s output byte-for-byte, but skips
// confirm.ts's match-against-a-target gate: D17c is populating the shared DB
// unconditionally (there is no target bundle yet), not confirming a guess
// against one. Per this task's ownership split, this file lives under
// tools/pkgsig/bulk/ (not src/**) and only *imports* from src/deps - it
// never modifies it.
//
// Fetch strategy deliberately differs from confirm.ts's own `npm pack` +
// hand-extract-one-directory approach: that only ever puts the *target*
// package's own files in place, never its transitive npm dependencies, so
// it can only work for zero-dependency packages (confirm.ts's own docs
// admit this path is "not exercised end-to-end" - docs/DEPS.md). Since most
// real npm packages (react-navigation, formik, most @react-native-* modules)
// have several of their own dependencies that must also be resolvable for
// Metro to bundle at all, this script instead runs
// `npm install <pkg>@<version> --ignore-scripts` in the shared per-job
// scaffold slot: `--ignore-scripts` disables *every* lifecycle script for
// the target AND its whole transitive tree (preinstall/install/postinstall
// never run for anyone), which is what D17a's "never executes package code"
// invariant actually requires - it is not specific to which fetch mechanism
// is used. The package (and whatever it uniquely pulled in) is uninstalled
// again after fingerprinting so the shared, reused scaffold slot stays
// close to pristine for the next job.
//
// Usage:
//   node build-one.mjs <pkg> <version> <hbcVersion> <scaffoldDir> <hermescPath> <outDbDir> [--refingerprint]
//
// D17c fix (docs/PACKAGE-SIGNATURES.md §6.4): every raw fingerprint has the
// (RN, hbc)-scaffold's toolchain/foundation baseline subtracted out before
// being written, via tools/pkgsig/bulk/baseline-subtract.mjs (ported logic,
// not importable from src/deps today — see that file's header). A written
// file always carries `bulkBuildFixVersion: 1` so assemble.sh --fixed-only
// and run.sh refingerprint can tell a properly-subtracted file from one
// written before this fix. If the (RN, hbc)'s baseline set isn't present
// yet (tools/pkgsig/bulk/build-baselines.mjs hasn't been run for it), the
// job FAILS rather than silently writing an unsubtracted file mislabelled
// as fixed - a retryable failure (per §6.2's existing failure-class
// tolerance), never a silent data-quality regression.
//
// --refingerprint: re-derive an ALREADY-BUILT entry's signature (bypasses
// the "already on disk -> skip" gate) using a cached compiled .hbc when one
// exists at outDbDir/../hbc-cache/<safeName>@<version>__hbc<N>.hbc (no
// re-download, no recompile), else runs the full install/bundle/compile
// pipeline exactly like a fresh job and populates that cache for next time.
//
// Exit codes: 0 = written (or already present -> skipped, non-refingerprint
// mode only), 1 = failed. Always prints one JSON line on stdout describing
// the outcome, for run.sh to log verbatim.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryPlan, entrySource, pipedOpts, runInstall, snapshotScaffoldPackage } from "./install-plan.mjs";
import { computeBaselineUnion, hasCompleteBaselineSet, subtractBaseline } from "./baseline-subtract.mjs";

// src/deps/db.ts's writeSignature() does a read-modify-write of a shared
// index.json (not written atomically or lock-protected - it was designed
// for hbc2js deps --confirm's single-process, sequential use, not this
// bulk build's 16-24-way parallelism). Racing writers would silently drop
// each other's index.json entries. Since that file is src/** (out of this
// task's ownership), guard the call from this side instead: a tiny
// mkdir-based mutual-exclusion lock (mkdir is atomic on POSIX filesystems)
// around just the fast index-update step, not the slow bundle/compile work.
function withIndexLock(dir, fn) {
  // docs/specs/15-sigdb-schema.md §4: `dir` ending in `.sqlite` is a sigdb
  // v3 file (writeSignature's own `.sqlite`-suffix dispatch), not a legacy
  // JSON layer directory with an index.json to lock — sqlite serializes
  // its own writers, and `dir` here names a file, not a directory `mkdir`
  // can lock against.
  if (dir.endsWith(".sqlite")) return fn();
  const lockPath = join(dir, ".index.lock");
  mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`timed out waiting for index lock at ${lockPath}`);
      execFileSync("sleep", ["0.05"]);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lockPath);
  }
}

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const { decodeFunction } = await import(join(REPO_ROOT, "src/disasm/decode.ts"));
const { parseHbc } = await import(join(REPO_ROOT, "src/parse/module.ts"));
const { fingerprintModule, SIG_HASH_SCHEME } = await import(join(REPO_ROOT, "src/deps/fingerprint.ts"));
const { writeSignature } = await import(join(REPO_ROOT, "src/deps/db.ts"));
const { BUILDER_METRO_CONFIG_NAME, builderConfigArgs, builderMetroConfigJs, bundleEnv, missingPeers, peerInstallArgv } = await import(join(REPO_ROOT, "src/deps/builder-support.ts"));
const { attachModulePaths, MODULE_PATHS_VERSION, modulePathsFromSourceMap } = await import(join(REPO_ROOT, "src/deps/module-paths.ts"));

const rawArgs = process.argv.slice(2);
const REFINGERPRINT = rawArgs.includes("--refingerprint");
const [pkg, version, hbcVersionStr, scaffoldDir, hermescPath, outDbDir] = rawArgs.filter((a) => !a.startsWith("--"));
if (!pkg || !version || !hbcVersionStr || !scaffoldDir || !hermescPath || !outDbDir) {
  console.error("usage: build-one.mjs <pkg> <version> <hbcVersion> <scaffoldDir> <hermescPath> <outDbDir> [--refingerprint]");
  process.exit(2);
}
const hbcVersion = Number(hbcVersionStr);

function safeName(p) { return p.replace(/\//g, "__"); }

function alreadyBuilt() {
  const p = join(outDbDir, `${safeName(pkg)}@${version}__hbc${hbcVersion}.json`);
  return existsSync(p);
}

// hbc-cache: <outDbDir>/../hbc-cache/<safeName>@<version>__hbc<N>.hbc.
// Populated on every successful compile (fresh build or refingerprint) so a
// later --refingerprint pass can skip install+bundle+hermesc entirely.
const hbcCacheDir = join(outDbDir, "..", "hbc-cache");
function hbcCachePath() {
  return join(hbcCacheDir, `${safeName(pkg)}@${version}__hbc${hbcVersion}.hbc`);
}

function installPackage() {
  const spec = `${pkg}@${version}`;
  // --ignore-scripts: no lifecycle script (preinstall/install/postinstall)
  // runs for `spec` or anything in its dependency tree - the D17a "never
  // executes package code" invariant. --no-save leaves the scaffold's own
  // package.json untouched (each slot is reused by many unrelated jobs).
  // BUILDONE1: strict first (installs peers), --legacy-peer-deps only as a
  // fallback - see install-plan.mjs.
  runInstall(spec, (cmd, argv) => execFileSync(cmd, argv, pipedOpts({ cwd: scaffoldDir, timeout: 180_000 })));
  // BUILDFAIL1(a): peers still absent after the (possibly legacy) install.
  try {
    const pj = JSON.parse(readFileSync(join(scaffoldDir, "node_modules", ...pkg.split("/"), "package.json"), "utf8"));
    const peers = missingPeers(pj, (n) => existsSync(join(scaffoldDir, "node_modules", ...n.split("/"), "package.json")));
    if (peers.length > 0) {
      execFileSync("npm", peerInstallArgv(spec, peers), pipedOpts({ cwd: scaffoldDir, timeout: 180_000 }));
      installedPeers.push(...peers.map((p) => p.name));
    }
  } catch {
    // Best effort; the bundle then fails as before.
  }
}
const installedPeers = [];

function uninstallPackage(names = [pkg, ...installedPeers]) {
  try {
    execFileSync("npm", ["uninstall", ...names, "--ignore-scripts", "--no-save", "--no-audit", "--no-fund"], {
      cwd: scaffoldDir,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 60_000,
    });
  } catch {
    // Best-effort slot cleanup; a failed uninstall just leaves a bit of
    // cruft in this slot for the next job, never breaks correctness (the
    // next job's own `npm install` resolves and overwrites whatever it
    // needs at that package's own path regardless of what's already there).
  }
}

function bundleAndCompile(workDir) {
  const slug = `${safeName(pkg)}-${version}-${hbcVersion}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const entryFile = join(scaffoldDir, `__bulk_entry_${slug}__.js`);
  const bundlePath = join(workDir, "out.bundle");
  const mapPath = join(workDir, "out.bundle.map");
  const assetsDir = join(workDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  // deps-recall-nosig: root + `exports` sub-paths first, root alone as the
  // fallback (install-plan.mjs entryPlan).
  const pkgDir = join(scaffoldDir, "node_modules", pkg);
  const { attempts } = existsSync(join(pkgDir, "package.json")) ? entryPlan(pkg, pkgDir) : { attempts: [[pkg]] };
  writeFileSync(join(scaffoldDir, BUILDER_METRO_CONFIG_NAME), builderMetroConfigJs());
  let lastErr;
  for (const specs of attempts) {
    writeFileSync(entryFile, entrySource(specs));
    try {
      execFileSync(
        "npx",
        ["react-native", "bundle", ...builderConfigArgs(scaffoldDir), "--platform", "android", "--dev", "false", "--minify", "true", "--max-workers", "1", "--reset-cache", "--entry-file", entryFile, "--bundle-output", bundlePath, "--sourcemap-output", mapPath, "--assets-dest", assetsDir],
        pipedOpts({ cwd: scaffoldDir, timeout: 120_000, env: bundleEnv() }),
      );
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    } finally {
      rmSync(entryFile, { force: true });
    }
  }
  if (lastErr !== undefined) throw lastErr;
  const hbcPath = join(workDir, "out.hbc");
  execFileSync(hermescPath, ["-O", "-emit-binary", `-out=${hbcPath}`, bundlePath], pipedOpts({ timeout: 60_000 }));
  // Module paths v1 (docs/PACKAGE-SIGNATURES.md §7): module id -> path
  // below node_modules, from Metro's source map. Null when no map.
  let paths = null;
  if (existsSync(mapPath)) paths = [...modulePathsFromSourceMap(JSON.parse(readFileSync(mapPath, "utf8")), readFileSync(bundlePath, "utf8"))];
  return { hbcPath, paths };
}

async function main() {
  if (alreadyBuilt() && !REFINGERPRINT) {
    console.log(JSON.stringify({ package: pkg, version, hbcVersion, ok: true, skipped: true }));
    return;
  }

  let workDir = null;
  let installed = false;
  let restoreScaffold = null; // deps-recall-nosig: slot already had pkg
  try {
    const cachePath = hbcCachePath();
    let bytes;
    let fromCache = false;
    // Module paths v1: cached beside the .hbc (`.paths.json`, [id, path]
    // pairs) so --refingerprint keeps them; absent = pathless, as before.
    const pathsCache = `${cachePath}.paths.json`;
    let modulePaths = null;
    if (REFINGERPRINT && existsSync(cachePath)) {
      bytes = new Uint8Array(readFileSync(cachePath));
      if (existsSync(pathsCache)) modulePaths = JSON.parse(readFileSync(pathsCache, "utf8"));
      fromCache = true;
    } else {
      restoreScaffold = snapshotScaffoldPackage(scaffoldDir, pkg);
      installPackage();
      installed = true;
      workDir = mkdtempSync(join(tmpdir(), "hbc2js-bulk-"));
      const built = bundleAndCompile(workDir);
      const hbcPath = built.hbcPath;
      modulePaths = built.paths;
      bytes = new Uint8Array(readFileSync(hbcPath));
      // Populate the cache for next time (fresh builds too, not just
      // refingerprint runs - cheap, .hbc files are small).
      mkdirSync(hbcCacheDir, { recursive: true });
      writeFileSync(cachePath, bytes);
      if (modulePaths !== null) writeFileSync(pathsCache, JSON.stringify(modulePaths));
    }

    const mod = parseHbc(bytes);
    if (mod.header.version !== hbcVersion) {
      throw new Error(`hermesc produced HBC version ${mod.header.version}, expected ${hbcVersion} (hermescPath=${hermescPath})`);
    }
    const fp = fingerprintModule(mod, decodeFunction);
    const legacyExactHashes = fp.legacyExactHashes;
    const { functions: rawFunctions, modules: rawModules } = modulePaths === null ? fp : attachModulePaths(mod, decodeFunction, fp.functions, fp.modules, new Map(modulePaths));

    const { hashes: baselineHashes, paths: subtractedBaselines, owners: baselineOwners } = computeBaselineUnion(outDbDir, hbcVersion);
    if (!hasCompleteBaselineSet(subtractedBaselines)) {
      throw new Error(`incomplete baseline set for hbc${hbcVersion} in ${outDbDir}/_baselines (found: ${subtractedBaselines.join(", ") || "none"}) - run build-baselines.mjs for this (RN, hbc) first`);
    }
    // LB1: ownership-aware (keeps this package's own functions that the
    // foundation also bundles) and scheme-1-baseline aware.
    const { functions, modules } = subtractBaseline(rawFunctions, rawModules, baselineHashes, { package: pkg, owners: baselineOwners, legacyExactHashes });

    const db = {
      schema: 2,
      hashScheme: SIG_HASH_SCHEME,
      ...(modulePaths !== null ? { modulePaths: MODULE_PATHS_VERSION } : {}),
      package: pkg,
      version,
      hbcVersion: mod.header.version,
      totalFunctions: functions.length,
      rawFunctionCount: rawFunctions.length,
      subtractedBaselines,
      functions,
      modules,
      toolchainBaseline: false,
      bulkBuildFixVersion: 1,
      provenance: {
        packageSha256: null,
        metroVersion: null,
        reactNativeVersion: null,
        hermescVersion: hbcVersion,
        hermescRnEra: null,
        repoCommit: null,
        builtAt: new Date().toISOString(),
      },
    };

    const written = withIndexLock(outDbDir, () => writeSignature(outDbDir, db));
    console.log(JSON.stringify({ package: pkg, version, hbcVersion, ok: true, functions: functions.length, rawFunctions: rawFunctions.length, modules: modules.length, fromCache, writtenTo: written }));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.log(JSON.stringify({ package: pkg, version, hbcVersion, ok: false, reason: reason.slice(0, 2000) }));
    process.exitCode = 1;
  } finally {
    if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
    if (restoreScaffold !== null) {
      restoreScaffold();
      if (installedPeers.length > 0) uninstallPackage(installedPeers);
    }
    else if (installed) uninstallPackage();
  }
}

main();
