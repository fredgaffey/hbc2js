// src/deps/bundles.ts — choose the inventory `deps` analyses when an input
// holds several Hermes bundles (docs/specs/32-webpack-inventory.md).
//
// Webpack bundles of one HBC version are merged into one inventory: a main
// bundle and its `*.chunk.bundle` files share one module-id space. Metro
// bundles are never merged (each has its own ids). The group with the most
// modules wins; ties go to more bytes, then to the first listed.

import { buildInventory } from "./inventory.ts";
import type { InventoryModule, ModuleInventory } from "./inventory.ts";
import type { BundleKind } from "./wscan.ts";

export { extractHermesBundlesFromApk } from "./apk.ts";

export interface BundleInput {
  readonly entryPath: string;
  readonly bytes: Uint8Array;
}

export interface BundleSummary {
  readonly entryPath: string;
  readonly kind: BundleKind;
  readonly hbcVersion: number;
  readonly totalModules: number;
  readonly bytes: number;
  /** Part of the inventory `deps` analysed. */
  readonly analysed: boolean;
}

/** Concatenate inventories, offsetting each one's function indices past
 *  the functions of the inventories before it. */
export function mergeInventories(parts: readonly ModuleInventory[]): ModuleInventory {
  if (parts.length === 1) return parts[0]!;
  const modules: InventoryModule[] = [];
  const functions: ModuleInventory["functions"][number][] = [];
  const legacyExact: string[] = [];
  const legacyFuzzy: string[] = [];
  let haveLegacy = true;
  let offset = 0;
  let moduled = 0;
  for (const inv of parts) {
    const shift = (i: number) => i + offset;
    for (const f of inv.functions) functions.push({ ...f, index: shift(f.index) });
    for (const m of inv.modules) {
      modules.push({ ...m, factoryFunctionIndex: shift(m.factoryFunctionIndex), nestedFunctionIndices: m.nestedFunctionIndices.map(shift), functionIndices: m.functionIndices.map(shift) });
    }
    if (inv.legacyExactHashes === undefined || inv.legacyFuzzyHashes === undefined) haveLegacy = false;
    else {
      legacyExact.push(...inv.legacyExactHashes);
      legacyFuzzy.push(...inv.legacyFuzzyHashes);
    }
    moduled += inv.moduledFunctionCount;
    offset += inv.totalFunctions;
  }
  return {
    hbcVersion: parts[0]!.hbcVersion,
    totalFunctions: offset,
    moduledFunctionCount: moduled,
    modules,
    functions,
    ...(haveLegacy ? { legacyExactHashes: legacyExact, legacyFuzzyHashes: legacyFuzzy } : {}),
    bundleKind: parts[0]!.bundleKind ?? "none",
  };
}

export function selectBundleInventory(bundles: readonly BundleInput[]): { inventory: ModuleInventory; bundles: BundleSummary[] } {
  if (bundles.length === 0) throw new Error("selectBundleInventory: no bundles");
  const invs = bundles.map((b) => buildInventory(b.bytes).inventory);
  // Groups of bundle positions: one per Metro/none bundle, one per HBC
  // version for webpack bundles.
  const groups: number[][] = [];
  const webpackGroup = new Map<number, number[]>();
  invs.forEach((inv, i) => {
    if (inv.bundleKind === "webpack") {
      let g = webpackGroup.get(inv.hbcVersion);
      if (g === undefined) {
        g = [];
        webpackGroup.set(inv.hbcVersion, g);
        groups.push(g);
      }
      g.push(i);
    } else groups.push([i]);
  });
  const score = (g: number[]) => [g.reduce((n, i) => n + invs[i]!.modules.length, 0), g.reduce((n, i) => n + bundles[i]!.bytes.length, 0)] as const;
  let best = groups[0]!;
  for (const g of groups.slice(1)) {
    const [m, b] = score(g);
    const [bm, bb] = score(best);
    if (m > bm || (m === bm && b > bb)) best = g;
  }
  const chosen = new Set(best);
  return {
    inventory: mergeInventories(best.map((i) => invs[i]!)),
    bundles: bundles.map((b, i) => ({ entryPath: b.entryPath, kind: invs[i]!.bundleKind ?? "none", hbcVersion: invs[i]!.hbcVersion, totalModules: invs[i]!.modules.length, bytes: b.bytes.length, analysed: chosen.has(i) })),
  };
}
