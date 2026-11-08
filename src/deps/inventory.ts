// src/deps/inventory.ts — the D17a "module inventory" step: enumerate Metro
// modules from the bytecode (the `__d(fn, id, deps)` registrations, found
// structurally via `dscan.ts` — never by decompiling everything) with their
// per-module function sets, string constants, and dependency edges.

import { createHash } from "node:crypto";
import { decodeFunction } from "../disasm/decode.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule, ParseOptions } from "../parse/types.ts";
import { fingerprintModule, functionStringEvidence } from "./fingerprint.ts";
import type { SigFunction } from "./sigdb-types.ts";
import type { BundleKind } from "./wscan.ts";

// Same truncated-sha256 convention as fingerprint.ts's own `sha256` (96
// bits, docs/PACKAGE-SIGNATURES.md §5.3) — kept as a private copy here
// rather than exported from fingerprint.ts so this file's new whole-set
// fuzzy hash cannot be mistaken for (or accidentally wired into) an
// existing sigdb-input field; see the FACTORY-ONLY note below.
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 24);
}

export interface InventoryModule {
  readonly factoryFunctionIndex: number;
  readonly localModuleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
  readonly nestedFunctionIndices: readonly number[];
  /** Factory function index followed by every nested closure — the module's
   *  full function set for the purposes of size/string-evidence gathering. */
  readonly functionIndices: readonly number[];
  readonly instrCount: number;
  readonly stringConstants: readonly string[];
  readonly exactHash: string | null;
  /** FACTORY-ONLY, same caveat as `exactHash`. Sigdb input. */
  readonly fuzzyHash: string | null;
  /** Hash-scheme-1 twins of `exactHash` / `fuzzyHash` (LB1), for per-module
   *  attribution against scheme-1 DB files. Optional for hand-built fixtures. */
  readonly legacyExactHash?: string | null;
  readonly legacyFuzzyHash?: string | null;
  readonly stringSetHash: string;
  /** The factory function's own string-set hash (not the module-wide
   *  `stringSetHash`, which is over exact hashes) — corroborates a
   *  fuzzy-only factory match when register allocation differs between
   *  builds (`-g`), see `match.ts`. FACTORY-ONLY. Sigdb input. */
  readonly factoryStringSetHash: string | null;
  readonly factoryStringCount: number;
  readonly factoryOnly: true;
  /** Fuzzy hash over the module's WHOLE function set (factory + every
   *  nested closure) — the fuzzy-tier analogue of `stringSetHash`, which
   *  already does this for the exact tier. Sorted per-function fuzzy
   *  hashes, joined and hashed, same convention as `stringSetHash`/
   *  `SigModule.functionSetHash` in fingerprint.ts. Two modules differing
   *  only in a nested closure's body (the common case — see `factoryOnly`)
   *  will NOT collide here even though they collide on `fuzzyHash`. New
   *  field, not a sigdb input (nothing reads it from a shipped sigdb file
   *  yet) — safe to compute freely. */
  readonly fuzzyHashSet: string;
  readonly nestedExactHashSet: string | null;
  /** Same as `nestedExactHashSet` but over fuzzy hashes — the nested-only
   *  analogue of `fuzzyHashSet`. `null` under the same no-nested-closures
   *  condition. New field, not a sigdb input. */
  readonly nestedFuzzyHashSet: string | null;
  /** String constants read from ONLY the module's nested closures — never
   *  the factory (an export-wrapper interop helper can itself introduce
   *  string constants, e.g. `"__esModule"`/`"default"`, that have nothing
   *  to do with the module's own logic and would otherwise pollute a
   *  strings-corroboration check the way `stringConstants`, which is
   *  factory-plus-nested, can). New field, not a sigdb input. */
  readonly nestedStringConstants: readonly string[];
}

export interface ModuleInventory {
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  /** Every function belonging to some `__d()` module (factory or nested). */
  readonly moduledFunctionCount: number;
  readonly modules: readonly InventoryModule[];
  readonly functions: readonly SigFunction[];
  /** Hash-scheme-1 (pre-LB1, width-unfolded) exact / fuzzy hash per
   *  function, parallel to `functions` (`FingerprintResult.legacyExactHashes`).
   *  `matchInventory` adds them to the target index so a scheme-1 DB file is
   *  scored against the target's scheme-1 hashes -- never against scheme-2
   *  ones. Optional: hand-built inventories omit them. */
  readonly legacyExactHashes?: readonly string[];
  readonly legacyFuzzyHashes?: readonly string[];
  /** `metro` (`__d`), `webpack` (Re.Pack module objects) or `none`
   *  (docs/specs/32-webpack-inventory.md). Optional: hand-built
   *  inventories omit it. */
  readonly bundleKind?: BundleKind;
}

export function buildInventoryFromModule(mod: HbcModule): ModuleInventory {
  const { functions, modules, legacyExactHashes, legacyFuzzyHashes, bundleKind } = fingerprintModule(mod, decodeFunction);
  const byIndex = new Map(functions.map((f) => [f.index, f]));

  const moduled = new Set<number>();
  const invModules: InventoryModule[] = modules.map((m) => {
    const nested = m.nestedFunctionIndices ?? [];
    const functionIndices = [m.factoryFunctionIndex, ...nested];
    for (const i of functionIndices) moduled.add(i);

    let instrCount = 0;
    const strings = new Set<string>();
    const fuzzyHashes: string[] = [];
    const nestedExactHashes: string[] = [];
    const nestedFuzzyHashes: string[] = [];
    const nestedStrings = new Set<string>();
    for (const idx of functionIndices) {
      const f = byIndex.get(idx);
      if (f !== undefined) instrCount += f.instrCount;
      if (f?.fuzzyHash !== undefined) fuzzyHashes.push(f.fuzzyHash);
      const decoded = decodeFunction(mod, idx);
      const idxStrings = functionStringEvidence(mod, decoded);
      for (const s of idxStrings) strings.add(s);
      if (idx !== m.factoryFunctionIndex) {
        if (f?.exactHash !== undefined) nestedExactHashes.push(f.exactHash);
        if (f?.fuzzyHash !== undefined) nestedFuzzyHashes.push(f.fuzzyHash);
        for (const s of idxStrings) nestedStrings.add(s);
      }
    }

    return {
      factoryFunctionIndex: m.factoryFunctionIndex,
      localModuleId: m.localModuleId,
      depCount: m.depCount,
      depIds: m.depIds,
      nestedFunctionIndices: nested,
      functionIndices,
      instrCount,
      stringConstants: [...strings].sort(),
      exactHash: m.factoryExactHash,
      fuzzyHash: m.factoryFuzzyHash,
      legacyExactHash: m.factoryExactHash === null ? null : (legacyExactHashes[m.factoryFunctionIndex] ?? null),
      legacyFuzzyHash: m.factoryFuzzyHash === null ? null : (legacyFuzzyHashes[m.factoryFunctionIndex] ?? null),
      stringSetHash: m.functionSetHash,
      factoryStringSetHash: byIndex.get(m.factoryFunctionIndex)?.stringSetHash ?? null,
      factoryStringCount: byIndex.get(m.factoryFunctionIndex)?.stringCount ?? 0,
      factoryOnly: true,
      fuzzyHashSet: sha256([...fuzzyHashes].sort().join("\n")),
      nestedExactHashSet: nested.length === 0 ? null : sha256([...nestedExactHashes].sort().join("\n")),
      nestedFuzzyHashSet: nested.length === 0 ? null : sha256([...nestedFuzzyHashes].sort().join("\n")),
      nestedStringConstants: [...nestedStrings].sort(),
    };
  });

  return {
    hbcVersion: mod.header.version,
    totalFunctions: functions.length,
    moduledFunctionCount: moduled.size,
    modules: invModules,
    functions,
    legacyExactHashes,
    legacyFuzzyHashes,
    bundleKind: bundleKind ?? "none",
  };
}

export function buildInventory(bytes: Uint8Array, options: ParseOptions = {}): { readonly module: HbcModule; readonly inventory: ModuleInventory } {
  const module = parseHbc(bytes, options);
  return { module, inventory: buildInventoryFromModule(module) };
}
