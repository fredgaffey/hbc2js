// corpus-offline-precision (2026-11-08): blind offline `deps` on the J3
// Expensify holdout confirmed 72 false positives (precision 53.5%, db-v3).
// One mechanism was a plain scoring bug: J4 dependency-aware subtraction
// (`tools/pkgsig/bulk/dep-subtract.mjs`) drops a module's factory FUNCTION
// when it matches one of the package's npm dependencies, but keeps the
// MODULE (graph anchoring) flagged `factoryIsDependency: true`, and
// `scorePackage` counted those modules as the package's own module hits.
// `victory-stack` reached "high" on 130 module hits with 0 function hits:
// every hit was a lodash/d3 module it depends on. These fixtures are
// synthetic (no app or APK data).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchInventory } from "../../../src/deps/match.ts";
import type { ModuleInventory } from "../../../src/deps/inventory.ts";
import type { LoadedSig } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

interface ModSpec { readonly hash: string; readonly dep: boolean }

function sig(pkg: string, mods: readonly ModSpec[], fns: readonly { hash: string; instr: number }[]): LoadedSig {
  // Dependency-flagged factories are absent from `functions`, as
  // dep-subtract.mjs writes them; own factories are present.
  const functions: SigDbFile["functions"][number][] = [];
  const modules: SigDbFile["modules"][number][] = mods.map((m, i) => {
    if (!m.dep) functions.push({ index: i, name: `f${i}`, paramCount: 3, instrCount: 30, exactHash: m.hash, fuzzyHash: `fz-${m.hash}`, stringSetHash: `s-${m.hash}`, stringCount: 1 });
    return { factoryFunctionIndex: i, localModuleId: i, depCount: 0, depIds: [], factoryExactHash: m.hash, factoryFuzzyHash: `fz-${m.hash}`, nestedFunctionCount: 0, functionSetHash: `set-${m.hash}`, factoryIsBaseline: false, factoryIsDependency: m.dep };
  });
  fns.forEach((f, j) => functions.push({ index: 100 + j, name: `g${j}`, paramCount: 1, instrCount: f.instr, exactHash: f.hash, fuzzyHash: `fz-${f.hash}`, stringSetHash: `s-${f.hash}`, stringCount: 1 }));
  const file: SigDbFile = {
    schema: 2, package: pkg, version: "1.0.0", hbcVersion: 98, totalFunctions: functions.length, rawFunctionCount: functions.length, subtractedBaselines: [], functions, modules, toolchainBaseline: false, hashScheme: 2,
    provenance: { packageSha256: null, metroVersion: null, reactNativeVersion: null, hermescVersion: 98, hermescRnEra: null, repoCommit: null, builtAt: "2026-11-08T00:00:00.000Z" },
  };
  return { file, layer: "shared", path: `/fixture/${pkg}.json` };
}

function target(hashes: readonly string[]): ModuleInventory {
  const functions = hashes.map((h, i) => ({ index: i, name: `t${i}`, paramCount: 3, instrCount: 30, exactHash: h, fuzzyHash: `fz-${h}`, stringSetHash: `s-${h}`, stringCount: 1 }));
  return {
    hbcVersion: 98, totalFunctions: functions.length, moduledFunctionCount: functions.length, functions,
    modules: hashes.map((h, i) => ({ factoryFunctionIndex: i, localModuleId: i, depCount: 0, depIds: [], nestedFunctionIndices: [], functionIndices: [i], instrCount: 30, stringConstants: [], exactHash: h, fuzzyHash: `fz-${h}`, stringSetHash: `s-${h}`, factoryStringSetHash: `s-${h}`, factoryStringCount: 1, factoryOnly: true, fuzzyHashSet: `fs-${h}`, nestedExactHashSet: null, nestedFuzzyHashSet: null, nestedStringConstants: [] })),
  };
}

const unmatched = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ hash: `${p}-own-unmatched-${i}`, instr: 30 }));

test("corpus-offline-precision: module hits that are all dependency-flagged (J4) never make a package 'high'", () => {
  const depMods = ["lodash-a", "lodash-b", "lodash-c", "d3-x"].map((hash) => ({ hash, dep: true }));
  const chart = sig("chart-wrapper", [...depMods, { hash: "chart-own-index", dep: false }], unmatched(10, "chart"));
  const report = matchInventory(target(["lodash-a", "lodash-b", "lodash-c", "d3-x"]), [chart]);
  const score = report.packages.find((p) => p.package === "chart-wrapper")!;
  assert.equal(score.moduleExactHits, 0, "dependency-flagged modules are the dependency's evidence, not chart-wrapper's");
  assert.notEqual(score.tier, "high");
});

test("corpus-offline-precision: the same package with those modules as its OWN still reaches 'high' (recall control)", () => {
  const ownMods = ["lodash-a", "lodash-b", "lodash-c", "d3-x"].map((hash) => ({ hash, dep: false }));
  const chart = sig("chart-wrapper", [...ownMods, { hash: "chart-own-index", dep: false }], unmatched(10, "chart"));
  const score = matchInventory(target(["lodash-a", "lodash-b", "lodash-c", "d3-x"]), [chart]).packages.find((p) => p.package === "chart-wrapper")!;
  assert.equal(score.moduleExactHits, 4);
  assert.equal(score.tier, "high");
});

test("corpus-offline-precision: dependency-flagged modules stay in moduleTotal, so dropping their hits cannot unlock the tiny-package path", () => {
  // 3 modules: one own module matched, one own unmatched, one dependency
  // module matched; 6 sizeable own functions match. Excluding the dep module
  // from the TOTAL too would make this a 2-module "tiny" package and its 6
  // function hits would clear the tiny path (measured: that variant added
  // react-shallow-renderer as a false positive on react-navigation-example).
  const own = Array.from({ length: 6 }, (_, i) => ({ hash: `rsr-fn-${i}`, instr: 30 }));
  const pkg = sig("shallow-like", [{ hash: "rsr-own-0", dep: false }, { hash: "rsr-own-1", dep: false }, { hash: "objassign-mod", dep: true }], [...own, ...unmatched(10, "rsr")]);
  const score = matchInventory(target(["rsr-own-0", "objassign-mod", ...own.map((f) => f.hash)]), [pkg]).packages.find((p) => p.package === "shallow-like")!;
  assert.equal(score.moduleTotal, 3);
  assert.equal(score.moduleExactHits, 1);
  assert.notEqual(score.tier, "high");
});
