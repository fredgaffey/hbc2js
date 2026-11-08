// src/deps/fingerprint.ts — per-function/per-module signature fingerprints
// for the D17 package-signature DB (promoted from
// `tools/pkgsig/lib/fingerprint.mjs`).
//
// Fingerprints every function in a compiled `.hbc` into the v2 signature-DB
// format (docs/PACKAGE-SIGNATURES.md §5.2): per-function exact/fuzzy/
// string-set-hash tiers (using `normaliseFunctionForSignature`, which masks
// the require()-call-site dependency-map index) plus a module-level entry
// per recovered `__d()` registration (`dscan.ts`).

import { createHash } from "node:crypto";
import { foldOperandWidth, hasWidthVariant, normaliseFunctionForSignature, signatureInstructions } from "./sig-normalise.ts";
import { scanBundleRegistrations } from "./dscan.ts";
import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction, Instruction } from "../disasm/decode.ts";
import type { SigFunction, SigModule } from "./sigdb-types.ts";

// Truncated to 96 bits (24 hex chars): signature DBs must stay compact and a
// birthday-bound collision is not a realistic risk at the function counts
// these DBs ever reach (docs/PACKAGE-SIGNATURES.md §5.3).
function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 24);
}

/** The signature hash scheme this code computes (`SigDbFile.hashScheme`).
 *  1 (field absent): pre-LB1, raw mnemonics. 2: operand-width variants
 *  folded (`foldOperandWidth`), docs/DEPS.md "Hash scheme 2". */
export const SIG_HASH_SCHEME = 2;

/** Bare mnemonic sequence — every operand dropped (the fuzzy tier). */
function fuzzyText(fn: DecodedFunction, fold = true): string {
  const lines: string[] = [];
  for (const { insn, labels } of signatureInstructions(fn)) {
    const prefix = labels.length > 0 ? "L:" : "";
    if (insn.kind === "switch") {
      const st = insn.switchTable;
      lines.push(`${prefix}SWITCH(${st ? st.cases.length : 0})`);
      continue;
    }
    lines.push(prefix + (fold ? foldOperandWidth(insn) : insn.name));
  }
  return lines.join("\n");
}

export function functionStrings(mod: HbcModule, fn: DecodedFunction): string[] {
  const set = new Set<string>();
  for (const insn of fn.instructions as readonly Instruction[]) {
    for (const op of insn.operands) {
      if (op.role === "string") set.add(mod.strings.get(op.value));
    }
  }
  return [...set].sort();
}

function stringSetHash(mod: HbcModule, fn: DecodedFunction): { hash: string; count: number } {
  const sorted = functionStrings(mod, fn);
  return { hash: sha256(sorted.join("\n")), count: sorted.length };
}

export interface FingerprintResult {
  readonly functions: readonly SigFunction[];
  readonly modules: readonly SigModule[];
  /** Hash-scheme-1 (pre-LB1, unfolded) exact / fuzzy hash per function,
   *  parallel to `functions` -- equal to the scheme-2 hash for every
   *  function without a width variant. Never written to a DB file; used to
   *  score scheme-1 files against a target and to subtract scheme-1
   *  baselines, so the two schemes are never compared to each other. */
  readonly legacyExactHashes: readonly string[];
  readonly legacyFuzzyHashes: readonly string[];
}

/**
 * Fingerprint one already-parsed module into the v2 per-function + per-module
 * signature arrays.
 */
export function fingerprintModule(mod: HbcModule, decodeFunction: (mod: HbcModule, index: number) => DecodedFunction): FingerprintResult {
  const functions: SigFunction[] = [];
  const legacyExactHashes: string[] = [];
  const legacyFuzzyHashes: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    const exactHash = sha256(normaliseFunctionForSignature(mod, fn));
    const fuzzyHash = sha256(fuzzyText(fn));
    const widthSensitive = hasWidthVariant(fn);
    legacyExactHashes.push(widthSensitive ? sha256(normaliseFunctionForSignature(mod, fn, { foldWidth: false })) : exactHash);
    legacyFuzzyHashes.push(widthSensitive ? sha256(fuzzyText(fn, false)) : fuzzyHash);
    const ss = stringSetHash(mod, fn);
    functions.push({
      index: i,
      name: fn.name,
      paramCount: fn.header.paramCount,
      instrCount: signatureInstructions(fn).length,
      exactHash,
      fuzzyHash,
      stringSetHash: ss.hash,
      stringCount: ss.count,
    });
  }

  let modules: SigModule[] = [];
  if (mod.functions.length > 0) {
    const byIndex = new Map(functions.map((f) => [f.index, f]));
    const collectNested = (factoryIdx: number, seen: Set<number>): number[] => {
      // Nested closures: any function whose CreateClosure appears lexically
      // inside the factory's own bytecode. One level only — matches "helper
      // closures a module defines".
      const fn = decodeFunction(mod, factoryIdx);
      const nested: number[] = [];
      for (const insn of fn.instructions) {
        for (const op of insn.operands) {
          if (op.role === "function" && !seen.has(op.value)) {
            seen.add(op.value);
            nested.push(op.value);
          }
        }
      }
      return nested;
    };

    modules = scanBundleRegistrations(mod, decodeFunction).map((reg) => {
      const seen = new Set([reg.factoryFunctionIndex]);
      const nestedIdx = collectNested(reg.factoryFunctionIndex, seen);
      const factory = byIndex.get(reg.factoryFunctionIndex);
      const nestedHashes = nestedIdx.map((i) => byIndex.get(i)?.exactHash).filter((h): h is string => h !== undefined);
      const allHashes = [factory?.exactHash, ...nestedHashes].filter((h): h is string => h !== undefined).sort();
      return {
        factoryFunctionIndex: reg.factoryFunctionIndex,
        localModuleId: reg.moduleId,
        depCount: reg.depCount,
        depIds: reg.depIds,
        factoryExactHash: factory?.exactHash ?? null,
        factoryFuzzyHash: factory?.fuzzyHash ?? null,
        nestedFunctionCount: nestedIdx.length,
        nestedFunctionIndices: nestedIdx,
        functionSetHash: sha256(allHashes.join("\n")),
        factoryIsBaseline: false,
      };
    });
  }

  return { functions, modules, legacyExactHashes, legacyFuzzyHashes };
}
