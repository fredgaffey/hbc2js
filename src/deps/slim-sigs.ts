// src/deps/slim-sigs.ts (deps-slim-sigs) — match-only compact signature
// records. `slimSigFile` projects a parsed signature file to the fields
// `matchInventory` reads; given a `SlimTarget` it also drops every function and
// module the match against that one target can never read, keeping only the
// precomputed counts (`SigDbFile.slim`). Result-neutral by construction: the
// matcher consults signature functions/modules only (a) through hash lookups
// keyed by the target's hash sets and (b) through `eligible`/`moduleTotal`
// counts. Never write a slim record back to a sigdb.

import type { ModuleInventory } from "./inventory.ts";
import { foreignSets, viaDependencyCounts } from "./module-paths.ts";
import { LEGACY_PREFIX, schemeKey } from "./match.ts";
import type { SigDbFile } from "./sigdb-types.ts";

/** Every scheme-keyed hash `matchInventory` can look a signature hash up
 *  against for one target (function and module level, scheme-2 and legacy). */
export interface SlimTarget {
  readonly minInstr: number;
  readonly exactKeys: ReadonlySet<string>;
  readonly fuzzyKeys: ReadonlySet<string>;
}

export function slimTargetFor(inventory: ModuleInventory, minInstr = 8): SlimTarget {
  const exactKeys = new Set<string>();
  const fuzzyKeys = new Set<string>();
  for (const f of inventory.functions) {
    exactKeys.add(f.exactHash);
    fuzzyKeys.add(f.fuzzyHash);
  }
  for (const h of inventory.legacyExactHashes ?? inventory.functions.map((f) => f.exactHash)) exactKeys.add(LEGACY_PREFIX + h);
  for (const h of inventory.legacyFuzzyHashes ?? inventory.functions.map((f) => f.fuzzyHash)) fuzzyKeys.add(LEGACY_PREFIX + h);
  for (const m of inventory.modules) {
    if (m.exactHash !== null) {
      exactKeys.add(m.exactHash);
      exactKeys.add(LEGACY_PREFIX + (m.legacyExactHash ?? m.exactHash));
    }
    if (m.fuzzyHash !== null) {
      fuzzyKeys.add(m.fuzzyHash);
      fuzzyKeys.add(LEGACY_PREFIX + (m.legacyFuzzyHash ?? m.fuzzyHash));
    }
  }
  return { minInstr, exactKeys, fuzzyKeys };
}

export function slimSigFile(f: SigDbFile, intern: Map<string, string>, target?: SlimTarget): SigDbFile {
  const s = (x: string): string => {
    const hit = intern.get(x);
    if (hit !== undefined) return hit;
    intern.set(x, x);
    return x;
  };
  const sn = (x: string | null): string | null => (x === null ? null : s(x));
  const fnRec = (fn: SigDbFile["functions"][number]): Record<string, unknown> => {
    const o: Record<string, unknown> = { index: fn.index, instrCount: fn.instrCount, exactHash: s(fn.exactHash), fuzzyHash: s(fn.fuzzyHash), stringSetHash: s(fn.stringSetHash), stringCount: fn.stringCount };
    if (fn.moduleId !== undefined) o.moduleId = fn.moduleId;
    return o;
  };
  const modRec = (m: SigDbFile["modules"][number]): Record<string, unknown> => {
    const o: Record<string, unknown> = { factoryFunctionIndex: m.factoryFunctionIndex, localModuleId: m.localModuleId, factoryExactHash: sn(m.factoryExactHash), factoryFuzzyHash: sn(m.factoryFuzzyHash), factoryIsBaseline: m.factoryIsBaseline };
    if (m.factoryIsDependency !== undefined) o.factoryIsDependency = m.factoryIsDependency;
    if (m.path !== undefined) o.path = m.path === null ? null : s(m.path);
    if (m.depIds !== undefined) o.depIds = m.depIds;
    return o;
  };
  const head = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { package: s(f.package), version: f.version, hbcVersion: f.hbcVersion, toolchainBaseline: f.toolchainBaseline };
    if (f.hashScheme !== undefined) o.hashScheme = f.hashScheme;
    // corpus-precision-forks: the twin rule reads declared dependencies,
    // the container rule the package's whole function count, the
    // embedded rule whether the file has module paths.
    if (f.subtractedDependencies !== undefined) o.subtractedDependencies = f.subtractedDependencies.map(s);
    if (f.dependencyClosure !== undefined) o.dependencyClosure = f.dependencyClosure.map(s);
    o.totalFunctions = f.totalFunctions;
    o.rawFunctionCount = f.rawFunctionCount;
    if (f.modulePaths !== undefined) o.modulePaths = f.modulePaths;
    return o;
  };
  const plain = (): SigDbFile => {
    const o = head();
    o.functions = f.functions.map(fnRec);
    o.modules = f.modules.map(modRec);
    return o as unknown as SigDbFile;
  };
  if (target === undefined) return plain();

  const foreign = foreignSets(f);
  const keep = (hash: string | null, set: ReadonlySet<string>): boolean => hash !== null && set.has(schemeKey(f, hash));
  let eligible = 0;
  const distinct = new Set<string>();
  for (const fn of f.functions) {
    if (fn.instrCount < target.minInstr || foreign.functions.has(fn.index)) continue;
    eligible++;
    distinct.add(fn.exactHash);
  }
  const fnByIndex = new Map(f.functions.map((fn) => [fn.index, fn]));
  const keptFn = new Set<number>();
  for (const fn of f.functions) {
    if (foreign.functions.has(fn.index)) continue;
    if (keep(fn.exactHash, target.exactKeys) || keep(fn.fuzzyHash, target.fuzzyKeys)) keptFn.add(fn.index);
  }
  let moduleTotal = 0;
  const keptModules: SigDbFile["modules"][number][] = [];
  for (const m of f.modules) {
    if (foreign.factories.has(m.factoryFunctionIndex)) continue;
    if (!m.factoryIsBaseline && m.factoryExactHash !== null) moduleTotal++;
    if (!keep(m.factoryExactHash, target.exactKeys) && !keep(m.factoryFuzzyHash, target.fuzzyKeys)) continue;
    // A kept module whose factory the matcher would treat as foreign for
    // hash ownership but still resolves by index: not representable without
    // the paths, so fall back to the unfiltered record for this file.
    if (foreign.functions.has(m.factoryFunctionIndex)) return plain();
    keptModules.push(m);
    if (fnByIndex.has(m.factoryFunctionIndex)) keptFn.add(m.factoryFunctionIndex);
  }
  // corpus-path-recall: own files that require another package's module
  // (and those modules) stay, with their counts, for promoteViaDependency.
  const graph = viaDependencyCounts(f, target.minInstr);
  const keptSet = new Set(keptModules);
  for (const m of graph.wrappers) {
    if (!keptSet.has(m)) {
      keptSet.add(m);
      keptModules.push(m);
    }
    for (const d of graph.depsOf(m)) {
      if (keptSet.has(d)) continue;
      keptSet.add(d);
      keptModules.push(d);
    }
  }
  const o = head();
  // corpus-precision-bundled-dist: own file sizes the `bundled-dist` rule reads.
  const fileSizes: Record<number, number> = {};
  if (f.modulePaths !== undefined && f.modulePaths >= 1) {
    const keptIds = new Set<number>();
    for (const fn of f.functions) if (keptFn.has(fn.index) && fn.moduleId !== undefined) keptIds.add(fn.moduleId);
    for (const fn of f.functions) if (fn.moduleId !== undefined && keptIds.has(fn.moduleId)) fileSizes[fn.moduleId] = (fileSizes[fn.moduleId] ?? 0) + 1;
  }
  // corpus-db-growth: foreign functions holding a target hash stay, with
  // their (foreign, path-bearing) module, so the matcher's path attribution
  // (`OwnView` in match.ts) sees whose code they are. They stay foreign.
  const foreignIdsKept = new Set<number>();
  for (const fn of f.functions) {
    if (!foreign.functions.has(fn.index) || !keep(fn.exactHash, target.exactKeys)) continue;
    keptFn.add(fn.index);
    if (fn.moduleId !== undefined) foreignIdsKept.add(fn.moduleId);
  }
  for (const m of f.modules) {
    if (keptSet.has(m) || !foreign.factories.has(m.factoryFunctionIndex)) continue;
    if ((m.localModuleId !== null && foreignIdsKept.has(m.localModuleId)) || keptFn.has(m.factoryFunctionIndex)) {
      keptSet.add(m);
      keptModules.push(m);
    }
  }
  o.functions = f.functions.filter((fn) => keptFn.has(fn.index)).map(fnRec);
  o.modules = keptModules.map(modRec);
  o.slim = { minInstr: target.minInstr, eligible, moduleTotal, distinctEligible: distinct.size, ...(f.modulePaths !== undefined && f.modulePaths >= 1 ? { ownPathDistinct: graph.ownPathDistinct, ownFuzzy: graph.ownFuzzy, fileSizes } : {}) };
  return o as unknown as SigDbFile;
}
