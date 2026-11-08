// src/deps/slim-sigs.ts (deps-slim-sigs) — match-only compact signature
// records. `slimSigFile` projects a parsed signature file to the fields
// `matchInventory` reads; given a `SlimTarget` it also drops every function and
// module the match against that one target can never read, keeping only the
// precomputed counts (`SigDbFile.slim`). Result-neutral by construction: the
// matcher consults signature functions/modules only (a) through hash lookups
// keyed by the target's hash sets and (b) through `eligible`/`moduleTotal`
// counts. Never write a slim record back to a sigdb.

import type { ModuleInventory } from "./inventory.ts";
import { foreignSets } from "./module-paths.ts";
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
    return o;
  };
  const head = (): Record<string, unknown> => {
    const o: Record<string, unknown> = { package: s(f.package), version: f.version, hbcVersion: f.hbcVersion, toolchainBaseline: f.toolchainBaseline };
    if (f.hashScheme !== undefined) o.hashScheme = f.hashScheme;
    if (f.subtractedDependencies !== undefined) o.subtractedDependencies = [];
    return o;
  };
  const plain = (): SigDbFile => {
    const o = head();
    if (f.modulePaths !== undefined) o.modulePaths = f.modulePaths;
    o.functions = f.functions.map(fnRec);
    o.modules = f.modules.map(modRec);
    return o as unknown as SigDbFile;
  };
  if (target === undefined) return plain();

  const foreign = foreignSets(f);
  const keep = (hash: string | null, set: ReadonlySet<string>): boolean => hash !== null && set.has(schemeKey(f, hash));
  let eligible = 0;
  for (const fn of f.functions) if (fn.instrCount >= target.minInstr && !foreign.functions.has(fn.index)) eligible++;
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
  const o = head();
  o.functions = f.functions.filter((fn) => keptFn.has(fn.index)).map(fnRec);
  o.modules = keptModules.map(modRec);
  o.slim = { minInstr: target.minInstr, eligible, moduleTotal };
  return o as unknown as SigDbFile;
}
