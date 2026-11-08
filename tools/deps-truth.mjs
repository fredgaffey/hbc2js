#!/usr/bin/env node
// tools/deps-truth.mjs — D17d ground truth for `hbc2js deps`.
//
//   node tools/deps-truth.mjs <bundle.hbc> <bundle.map> --bundle-js <bundle.js> [--write-truth <truth.json>] [--also-hbc <debug.hbc>] [--json]
//   node tools/deps-truth.mjs <bundle.hbc> <truth.json> [--json]
//
// Metro's source map (`--sourcemap-output`) records the source file of every
// generated line; each `__d(...)` module is one line of the minified bundle
// ending in `},<id>,[deps]);`, so line -> source path -> `node_modules/<pkg>`
// (+ that package's package.json version) is per-module truth. A compact
// `truth.json` (module id -> package@version, plus the .hbc's sha256) is
// what fixtures commit, so scoring never needs the 3+ MB map or a
// node_modules tree. Scores the deps report: precision/recall for the
// confirmed and guessed tiers, per-module attribution accuracy, and the
// false positives / misses by name.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDeps } from "../src/deps/index.ts";
import { flattenIndexMap, sourcePerLine } from "../src/deps/module-paths.ts";

const BASELINE_ALIAS = { "react-foundation": "react", "react-native-foundation": "react-native", "metro-toolchain-empty": null };

// --- source map ----------------------------------------------------------

// decodeVlq / sourcePerLine / flattenIndexMap: shared with the signature
// builder (module paths v1), src/deps/module-paths.ts.

function packageFromSource(source) {
  const idx = source.lastIndexOf("node_modules/");
  if (idx < 0) return null;
  const rest = source.slice(idx + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const root = source.slice(0, idx + "node_modules/".length) + name;
  return { name, root };
}

// A pnpm/yarn/npm/lerna workspace monorepo's own sibling packages (e.g. this
// tool's own react-navigation-example fixture, whose `example/` app depends
// on `@react-navigation/*` via the workspace protocol) resolve straight to
// that package's *source* directory, never through `node_modules/` at all —
// Metro's source map records e.g. `/packages/native/src/index.tsx`, not a
// `node_modules/@react-navigation/native/...` path. `packageFromSource`
// above has no way to see these; only fires when the caller passes `--root`
// (the workspace root the bundle was built from — a temp clone, gone by the
// time a fixture's committed `truth.json` is later scored, so this is a
// generation-time-only fallback, opt-in, never required for scoring).
function packageFromWorkspaceSource(source, root) {
  const m = /^\/?packages\/([^/]+)\//.exec(source);
  if (m === null) return null;
  const pkgDir = join(root, "packages", m[1]);
  try {
    const doc = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (typeof doc.name !== "string" || doc.name.length === 0) return null;
    return { name: doc.name, root: pkgDir };
  } catch {
    return null;
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function truthFromMap(hbcPaths, mapPath, bundleJsPath, opts = {}) {
  const map = flattenIndexMap(JSON.parse(readFileSync(mapPath, "utf8")));
  const srcPerLine = sourcePerLine(map);
  const jsLines = readFileSync(bundleJsPath, "utf8").split("\n");
  const modules = {};
  const versions = new Map();
  const rootByPackageName = new Map();
  // A module is usually one line, but the minifier can keep newlines inside
  // one (RN 0.87's react.production.js spans 12): it runs from its `__d(`
  // line to the first line ending in `},<id>,[deps]);`, and its source is
  // the first mapped line's (a bare `__d(function(...){` line can be unmapped).
  let start = -1;
  jsLines.forEach((text, i) => {
    if (text.startsWith("__d(")) start = i;
    if (start < 0) return;
    const m = /\}\)?,(\d+),\[[\d,]*\]\);\s*$/.exec(text);
    if (m === null) return;
    let srcIdx = null;
    for (let j = start; j <= i && srcIdx === null; j++) srcIdx = srcPerLine[j] ?? null;
    start = -1;
    const source = srcIdx === null || srcIdx === undefined ? null : map.sources[srcIdx];
    let pkg = source === null ? null : packageFromSource(source);
    if (pkg === null && source !== null && opts.root !== undefined) pkg = packageFromWorkspaceSource(source, opts.root);
    let version = null;
    if (pkg !== null) {
      if (!versions.has(pkg.root)) {
        try {
          versions.set(pkg.root, JSON.parse(readFileSync(join(pkg.root, "package.json"), "utf8")).version ?? null);
        } catch {
          versions.set(pkg.root, null);
        }
      }
      version = versions.get(pkg.root);
      if (!rootByPackageName.has(pkg.name)) rootByPackageName.set(pkg.name, pkg.root);
    }
    modules[m[1]] = { package: pkg?.name ?? null, version, source: source === null ? null : source.slice(source.lastIndexOf("node_modules/") >= 0 ? source.lastIndexOf("node_modules/") : Math.max(0, dirname(bundleJsPath).length + 1)) };
  });
  const packages = {};
  // Keyed off `rootByPackageName` (recorded at insertion time above) rather
  // than re-derived by matching `node_modules/<name>` against `versions`'
  // keys — that suffix match can never find a workspace package's root
  // (`packageFromWorkspaceSource` above), and is redundant work besides.
  const roots = new Map();
  for (const m of Object.values(modules)) {
    if (m.package === null || m.package in packages) continue;
    packages[m.package] = m.version;
    roots.set(m.package, rootByPackageName.get(m.package));
  }
  // A truth package that some other truth package declares as a dependency
  // is "transitive": the signature DB fingerprints a package *with* its
  // dependencies bundled (minus the toolchain baselines), so e.g. every
  // @babel/runtime helper module in an RN app is, by the DB's construction,
  // attributed to react-native. Recall is therefore reported over direct
  // (top-level) packages as well as over all of them.
  const transitiveOf = {};
  for (const [pkg, root] of roots) {
    if (root === undefined) continue;
    let deps = {};
    try {
      const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      deps = pj.dependencies ?? {};
    } catch {
      continue;
    }
    for (const dep of Object.keys(deps)) {
      if (dep in packages && dep !== pkg) (transitiveOf[dep] ??= []).push(pkg);
    }
  }
  // Direct dependencies: what the app's own package.json (next to the
  // bundle, when the bundle was built in the project root) declares.
  let direct = null;
  try {
    const app = JSON.parse(readFileSync(join(dirname(bundleJsPath), "package.json"), "utf8"));
    direct = Object.keys(app.dependencies ?? {}).filter((d) => d in packages).sort();
  } catch {
    // no app package.json reachable — scoring falls back to "not transitive".
  }
  const hbcSha256s = {};
  for (const h of hbcPaths) hbcSha256s[h.slice(h.lastIndexOf("/") + 1)] = sha256File(h);
  return { hbcSha256s, moduleCount: Object.keys(modules).length, packages, direct, transitiveOf, modules };
}

// --- scoring -------------------------------------------------------------

function ownerPackage(owner) {
  const raw = owner.slice(0, owner.lastIndexOf("@"));
  return raw in BASELINE_ALIAS ? BASELINE_ALIAS[raw] : raw;
}

export async function scoreAgainstTruth(hbcPath, truth, depsOptions = { offline: true }) {
  const result = await runDeps(hbcPath, depsOptions);
  const r = result.report;
  const truthPkgs = new Set(Object.keys(truth.packages));
  const confirmed = new Set(r.confirmedDeps.map((d) => d.package));
  const guessed = new Set(r.guessedDeps.map((d) => d.package));
  // `hint` tier (D17a, extended 2026-08-30): single-evidence-kind leads kept
  // only when that one kind is high-specificity (`isHintEligibleEvidence`,
  // src/deps/guess.ts). Scored separately from `guessed` — precision only,
  // same as guessed (no recall bar: a hint's whole point is surviving on
  // one clue, so it's expected to be a small, high-precision list, not a
  // complete one).
  const hinted = new Set((r.hintedDeps ?? []).map((d) => d.package));
  const inter = (a, b) => [...a].filter((x) => b.has(x));
  const directPkgs = new Set(truth.direct ?? [...truthPkgs].filter((p) => !(p in (truth.transitiveOf ?? {}))));
  const confirmedTP = inter(confirmed, truthPkgs);
  const guessedTP = inter(guessed, truthPkgs);
  const hintedTP = inter(hinted, truthPkgs);
  const remaining = new Set([...truthPkgs].filter((p) => !confirmed.has(p)));
  const ratio = (n, d) => (d === 0 ? null : n / d);

  // Module-COUNT accuracy (unweighted) plus, per issue #14 F2, the same
  // breakdown weighted by `instrCount` — module count treats a 3-instruction
  // re-export and a 2,000-instruction library core identically, so it can
  // look far healthier than how much of the bundle's actual bytecode was
  // recovered. `instrWeight` mirrors every counter 1:1 by summing
  // `m.instrCount` instead of incrementing by 1.
  const perModule = { withTruth: 0, correct: 0, viaDependent: 0, wrong: 0, unattributed: 0, appModulesAttributed: 0 };
  const instrWeight = { withTruth: 0, correct: 0, viaDependent: 0, wrong: 0, unattributed: 0, appModulesAttributed: 0 };
  const wrongModules = [];
  for (const m of result.matchReport.moduleAttributions) {
    const t = m.localModuleId === null ? undefined : truth.modules[String(m.localModuleId)];
    const owner = m.owners[0] === undefined ? null : ownerPackage(m.owners[0]);
    if (t === undefined) continue;
    if (t.package === null) {
      if (owner !== null) {
        perModule.appModulesAttributed++;
        instrWeight.appModulesAttributed += m.instrCount;
      }
      continue;
    }
    perModule.withTruth++;
    instrWeight.withTruth += m.instrCount;
    if (owner === null) {
      perModule.unattributed++;
      instrWeight.unattributed += m.instrCount;
    } else if (owner === t.package) {
      perModule.correct++;
      instrWeight.correct += m.instrCount;
    } else if ((truth.transitiveOf?.[t.package] ?? []).includes(owner)) {
      perModule.viaDependent++;
      instrWeight.viaDependent += m.instrCount;
    } else {
      perModule.wrong++;
      instrWeight.wrong += m.instrCount;
      wrongModules.push({ id: m.localModuleId, truth: t.package, reported: owner, basis: m.ownerBasis });
    }
  }

  return {
    input: hbcPath,
    hbcSha256Matches: Object.values(truth.hbcSha256s ?? {}).includes(sha256File(hbcPath)),
    reactNativeVersion: r.reactNativeVersion,
    truthPackages: [...truthPkgs].sort(),
    directPackages: [...directPkgs].sort(),
    confirmed: { reported: [...confirmed].sort(), precision: ratio(confirmedTP.length, confirmed.size), recall: ratio(confirmedTP.length, truthPkgs.size), directRecall: ratio(inter(confirmed, directPkgs).length, directPkgs.size), falsePositives: [...confirmed].filter((p) => !truthPkgs.has(p)), misses: [...truthPkgs].filter((p) => !confirmed.has(p)) },
    guessed: { reported: [...guessed].sort(), precision: ratio(guessedTP.length, guessed.size), recall: ratio(inter(guessed, remaining).length, remaining.size), falsePositives: [...guessed].filter((p) => !truthPkgs.has(p)), misses: [...remaining].filter((p) => !guessed.has(p)) },
    hinted: { reported: [...hinted].sort(), precision: ratio(hintedTP.length, hinted.size), falsePositives: [...hinted].filter((p) => !truthPkgs.has(p)) },
    versionMismatches: r.confirmedDeps.filter((d) => truthPkgs.has(d.package) && truth.packages[d.package] !== null && truth.packages[d.package] !== d.version).map((d) => `${d.package}: reported ${d.version}, truth ${truth.packages[d.package]}`),
    reactNativeVersionConsistentWithHbc: r.reactNativeVersionConsistentWithHbc,
    reactNativeVersionExpectedRange: r.reactNativeVersionExpectedRange,
    perModule: { ...perModule, accuracy: ratio(perModule.correct, perModule.withTruth), wrongModules },
    // Instruction-weight mirror of `perModule` (issue #14 F2) — recall over
    // the *known-library* modules' actual bytecode mass, i.e. "of all the
    // instructions truth says belong to a real dependency, how many did this
    // tool's own module attribution actually get right." Distinct from (and
    // a tighter number than) `attribution.percentVerifiedByWeight`, which is
    // over the *whole* bundle including this app's own first-party code.
    perModuleByWeight: { ...instrWeight, accuracy: ratio(instrWeight.correct, instrWeight.withTruth) },
    attribution: r.attribution,
  };
}

function pct(x) {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

// Actionable failure message for a `hbcSha256Matches: false` score, in the
// style of the fixture's own `t.skip("... not fetched (run .../fetch.sh)")`
// guards (e.g. tests/projdb/init-real-bundle.test.ts): name the file, name
// the truth file, and say what to do, rather than an opaque
// `assert.ok(s.hbcSha256Matches)` with no message. Returns null when there
// is nothing to report.
//
// Re-pinning is offered because a fixture's .hbc is a gitignored local
// artifact that can drift from the truth file's pin without the truth data
// itself being wrong (2026-09-28 J1). It is only safe when the SOURCE JS the
// .hbc was compiled from is unchanged -- then the map-derived truth still
// describes the same modules. It is NOT safe after re-running a fetch.sh that
// clones an unpinned upstream HEAD (as the react-navigation-example one does):
// that produces a different app build, and the map, truth file and every .hbc
// must be regenerated together in that same run. hermesc itself is
// deterministic on a fixed input and binary, so a mismatch is drift in the
// artifacts, never compiler noise. See docs/DEPS.md "Sha pin drift".
export function shaGuardMessage(s, truthPath) {
  if (s.hbcSha256Matches) return null;
  const name = s.input.slice(s.input.lastIndexOf("/") + 1);
  return (
    `${s.input}: sha256 does not match any pin in ${truthPath}'s hbcSha256s. ` +
    `This .hbc and the truth file come from different builds. If the source JS ` +
    `bundle next to it is unchanged (recompile it and compare -- hermesc is ` +
    `deterministic), the truth data still applies and you may re-pin ` +
    `hbcSha256s[${JSON.stringify(name)}] in ${truthPath} to this file's actual ` +
    `sha256. If instead the bundle changed, or you re-ran a fetch.sh that clones ` +
    `an unpinned upstream HEAD, do NOT re-pin: regenerate the map, the truth ` +
    `file and every .hbc together -- see this fixture's BUILD.md and ` +
    `docs/DEPS.md "Sha pin drift".`
  );
}

export function formatScore(s) {
  const lines = [];
  lines.push(`deps-truth: ${s.input}${s.hbcSha256Matches ? "" : "  (WARNING: .hbc sha256 differs from the truth file's)"}`);
  let rnLine = `  truth: ${s.truthPackages.length} packages (${s.directPackages.length} direct: ${s.directPackages.join(", ")}); react-native detected: ${s.reactNativeVersion ?? "null"}`;
  if (s.reactNativeVersion !== null) {
    if (s.reactNativeVersionConsistentWithHbc === false) rnLine += ` (WARNING: inconsistent with parsed HBC version, expected ${s.reactNativeVersionExpectedRange ?? "a different range"})`;
    else if (s.reactNativeVersionExpectedRange !== null) rnLine += ` [consistent with ${s.reactNativeVersionExpectedRange}]`;
  }
  lines.push(rnLine);
  lines.push(`  confirmed: ${s.confirmed.reported.length} reported, precision ${pct(s.confirmed.precision)}, recall ${pct(s.confirmed.recall)} of all / ${pct(s.confirmed.directRecall)} of direct`);
  if (s.confirmed.falsePositives.length > 0) lines.push(`    FALSE POSITIVES: ${s.confirmed.falsePositives.join(", ")}`);
  if (s.confirmed.misses.length > 0) lines.push(`    misses: ${s.confirmed.misses.join(", ")}`);
  if (s.versionMismatches.length > 0) lines.push(`    version mismatches: ${s.versionMismatches.join("; ")}`);
  lines.push(`  guessed: ${s.guessed.reported.length} reported, precision ${pct(s.guessed.precision)}, recall-of-remaining ${pct(s.guessed.recall)}`);
  if (s.guessed.falsePositives.length > 0) lines.push(`    false positives: ${s.guessed.falsePositives.join(", ")}`);
  if (s.guessed.misses.length > 0) lines.push(`    misses: ${s.guessed.misses.join(", ")}`);
  lines.push(`  hinted: ${s.hinted.reported.length} reported, precision ${pct(s.hinted.precision)} (single-evidence leads; not gated, no recall bar by design)`);
  if (s.hinted.falsePositives.length > 0) lines.push(`    false positives: ${s.hinted.falsePositives.join(", ")}`);
  const m = s.perModule;
  lines.push(`  per-module: ${m.withTruth} library modules — ${m.correct} correct (${pct(m.accuracy)}), ${m.viaDependent} attributed to the package that depends on them, ${m.wrong} wrong package, ${m.unattributed} unattributed; ${m.appModulesAttributed} app modules wrongly attributed`);
  for (const w of m.wrongModules.slice(0, 10)) lines.push(`    module ${w.id}: truth ${w.truth}, reported ${w.reported} (${w.basis})`);
  // F2 (issue #14): recall over the known-library modules' actual bytecode
  // mass, not just their count — the number this task's headline problem
  // ("stripped only ~1.6% of code by instruction weight") is stated in.
  const w = s.perModuleByWeight;
  lines.push(`  per-module BY INSTRUCTION WEIGHT: ${w.withTruth} instr in library modules — ${w.correct} correct (${pct(w.accuracy)}), ${w.viaDependent} via dependent, ${w.wrong} wrong, ${w.unattributed} unattributed`);
  if (s.attribution !== undefined) {
    const a = s.attribution;
    lines.push(`  whole-bundle by weight: ${pct(a.percentVerifiedByWeight / 100)} of ALL bundle instructions verified (signature-matched: ${a.matchedInstrWeight}/${a.totalInstrWeight}), ${pct(a.percentAttributedByWeight / 100)} attributed overall (+guessed)`);
  }
  return lines.join("\n");
}

async function main(argv) {
  const positional = [];
  let bundleJs;
  let writeTruth;
  let root;
  const alsoHbc = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle-js") bundleJs = argv[++i];
    else if (a === "--write-truth") writeTruth = argv[++i];
    else if (a === "--also-hbc") alsoHbc.push(argv[++i]);
    else if (a === "--root") root = argv[++i];
    else if (a === "--json") json = true;
    else positional.push(a);
  }
  const [hbcPath, truthOrMap] = positional;
  if (hbcPath === undefined || truthOrMap === undefined) {
    process.stderr.write("usage: deps-truth.mjs <bundle.hbc> <bundle.map|truth.json> [--bundle-js <bundle.js>] [--write-truth <truth.json>] [--also-hbc <other.hbc>] [--root <workspace-dir>] [--json]\n");
    return 2;
  }
  let truth;
  if (truthOrMap.endsWith(".map")) {
    if (bundleJs === undefined) {
      process.stderr.write("--bundle-js <bundle.js> is required with a .map (module ids come from the bundle's __d lines)\n");
      return 2;
    }
    truth = truthFromMap([hbcPath, ...alsoHbc], truthOrMap, bundleJs, root !== undefined ? { root } : {});
    if (writeTruth !== undefined) writeFileSync(writeTruth, JSON.stringify(truth, null, 1) + "\n");
  } else {
    truth = JSON.parse(readFileSync(truthOrMap, "utf8"));
  }
  const score = await scoreAgainstTruth(hbcPath, truth);
  process.stdout.write((json ? JSON.stringify(score, null, 2) : formatScore(score)) + "\n");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
