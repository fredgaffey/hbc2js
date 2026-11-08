// src/deps/baseline-owners.ts — LB1(d) (docs/DEPS.md "Why exact-version
// signatures miss"): which npm package owns each function of a baseline
// (foundation) bundle, so baseline subtraction can keep a package's OWN
// functions when the foundation happens to contain that package too (RN
// itself depends on regenerator-runtime, promise, invariant, ...).
//
// Ownership is per `__d()` module (`dscan.ts`): the factory plus every
// closure it creates, transitively. The module -> package map comes from
// the caller (`build-baselines.mjs` derives it from Metro's source map via
// `tools/deps-truth.mjs`'s `truthFromMap`). A function reached from two
// modules with different owners, or from none (the global function,
// polyfills), gets `null`: subtraction treats `null` as "someone else's".

import { scanBundleRegistrations } from "./dscan.ts";
import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction } from "../disasm/decode.ts";

export function computeFunctionOwners(mod: HbcModule, decodeFunction: (mod: HbcModule, index: number) => DecodedFunction, ownerOfModuleId: (moduleId: number) => string | null): (string | null)[] {
  const owners: (string | null | undefined)[] = new Array(mod.functions.length).fill(undefined);
  const CONFLICT = null;
  if (mod.functions.length === 0) return [];
  const regs = scanBundleRegistrations(mod, decodeFunction);
  for (const reg of regs) {
    const owner = reg.moduleId === null ? null : ownerOfModuleId(reg.moduleId);
    const seen = new Set<number>([reg.factoryFunctionIndex]);
    const stack = [reg.factoryFunctionIndex];
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const prev = owners[idx];
      owners[idx] = prev === undefined || prev === owner ? owner : CONFLICT;
      for (const insn of decodeFunction(mod, idx).instructions) {
        for (const op of insn.operands) {
          if (op.role === "function" && !seen.has(op.value) && op.value !== 0) {
            seen.add(op.value);
            stack.push(op.value);
          }
        }
      }
    }
  }
  return owners.map((o) => o ?? null);
}
