// src/deps/dscan.ts — Metro `__d(factory, id, deps)` module-graph recovery.
//
// Promoted from `tools/pkgsig/lib/dscan.mjs` (D17/T8 prototype) into typed
// `src/deps/**` per this milestone's task boundary. Behaviour is unchanged
// from the prototype (docs/PACKAGE-SIGNATURES.md §3.1/§5.3): a single
// forward dataflow scan over the `global` function's decoded instructions,
// recovering every `TryGetById "__d"` -> `CreateClosure` -> `LoadConst*` ->
// `NewArray[WithBuffer]` -> `Call4`/`Call5` quintuple Metro's Babel
// transform emits. This is the module-inventory anchor D17a/D19 both need:
// which Hermes function index is a Metro module's factory, its local
// numeric module id, and its ordered dependency-id array — recovered
// structurally, with no fingerprinting/signature lookup involved.
//
// Heuristic, not a verified-exhaustive decoder: falls back to `depCount:
// null` / `depIds: null` for any deps-array construction shape other than
// `NewArray <n>, 0` (empty) or `NewArrayWithBuffer[Long]` (small-integer
// literal array).

import { readLiterals } from "../parse/buffers.ts";
import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction } from "../disasm/decode.ts";

export interface ModuleRegistration {
  readonly factoryFunctionIndex: number;
  readonly moduleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
  /** The raw string id when the bundle registers modules under string ids
   *  (a custom Metro `createModuleIdFactory`, corpus a10: 8-hex-digit hashes
   *  like `__d(factory, "bb416d32", ["d339d332"])`). `moduleId`/`depIds` then
   *  hold synthetic numeric ids: see `stringModuleIdMap`. */
  readonly moduleKey?: string;
}

/** A registration as scanned, before string ids are numbered. */
type RawRegistration = { readonly factoryFunctionIndex: number; readonly id: number | string | null; readonly deps: readonly (number | string | null)[] | null };

const LOAD_CONST_NUMERIC = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);
const GET_BY_ID_LIKE = new Set(["TryGetById", "TryGetByIdLong", "GetById", "GetByIdLong", "GetByIdShort"]);

/** `__d`, or Metro's `__METRO_GLOBAL_PREFIX__` form `<prefix>__d`
 *  (corpus-B4: `__acme_app__d`). */
export function isDefineGlobalName(name: string | undefined): boolean {
  return name === "__d" || (name !== undefined && /^[A-Za-z0-9_$]+__d$/.test(name));
}

type RegState = { readonly kind: "__d" } | { readonly kind: "factory"; readonly index: number } | { readonly kind: "id"; readonly value: number | string | null } | { readonly kind: "deps"; readonly ids: readonly (number | string | null)[] | null } | undefined;

/**
 * Scan `global`'s (function index 0) decoded instructions for every
 * `__d(factory, id, deps)` registration call.
 */
export function scanModuleRegistrations(mod: HbcModule, globalFn: DecodedFunction): ModuleRegistration[] {
  return numberRegistrations(scanRaw(mod, globalFn));
}

function scanRaw(mod: HbcModule, globalFn: DecodedFunction): RawRegistration[] {
  const regState = new Map<number, RegState>();
  const modules: RawRegistration[] = [];

  for (const insn of globalFn.instructions) {
    const ops = insn.operands;

    if (GET_BY_ID_LIKE.has(insn.name)) {
      const strOp = ops.find((o) => o.role === "string");
      if (ops[0]?.role === "reg") {
        const isD = strOp !== undefined && isDefineGlobalName(mod.strings.get(strOp.value));
        regState.set(ops[0].value, isD ? { kind: "__d" } : undefined);
      }
      continue;
    }

    if ((insn.name === "CreateClosure" || insn.name === "CreateClosureLongIndex") && ops[0]?.role === "reg") {
      const fnOp = ops.find((o) => o.role === "function");
      regState.set(ops[0].value, fnOp !== undefined ? { kind: "factory", index: fnOp.value } : undefined);
      continue;
    }

    if (LOAD_CONST_NUMERIC.has(insn.name) && ops[0]?.role === "reg") {
      const value = insn.name === "LoadConstZero" ? 0 : (ops[1]?.value ?? null);
      regState.set(ops[0].value, { kind: "id", value });
      continue;
    }

    if ((insn.name === "LoadConstString" || insn.name === "LoadConstStringLongIndex") && ops[0]?.role === "reg") {
      const strOp = ops.find((o) => o.role === "string");
      const value = strOp !== undefined ? mod.strings.get(strOp.value) : undefined;
      regState.set(ops[0].value, { kind: "id", value: value ?? null });
      continue;
    }

    if (insn.name === "NewArray" && ops[0]?.role === "reg") {
      const sizeHint = ops[1]?.value ?? -1;
      regState.set(ops[0].value, { kind: "deps", ids: sizeHint === 0 ? [] : null });
      continue;
    }

    if ((insn.name === "NewArrayWithBuffer" || insn.name === "NewArrayWithBufferLong") && ops[0]?.role === "reg") {
      const numLiterals = ops[2]?.value ?? 0;
      const litOp = ops.find((o) => o.role === "literalOffset");
      let ids: (number | string | null)[] | null = null;
      if (litOp !== undefined) {
        try {
          const { values } = readLiterals(mod.literalValueBuffer, litOp.value, numLiterals, mod.header.version);
          ids = values.map((v) => (v.kind === "integer" || v.kind === "number" ? v.value : v.kind === "string" ? (mod.strings.get(v.stringId) ?? null) : null));
        } catch {
          ids = null;
        }
      }
      regState.set(ops[0].value, { kind: "deps", ids });
      continue;
    }

    if (((insn.name === "Call4" || insn.name === "Call5") && ops.length >= 6) || (insn.name === "Call3" && ops.length >= 5)) {
      const callee = regState.get(ops[1]!.value);
      if (callee?.kind === "__d") {
        const factory = regState.get(ops[3]!.value);
        const id = regState.get(ops[4]!.value);
        // Call3 is the two-argument `__d(factory, id)` form (corpus-B4): no deps array.
        const deps = insn.name === "Call3" ? undefined : regState.get(ops[5]!.value);
        if (factory?.kind === "factory") {
          modules.push({
            factoryFunctionIndex: factory.index,
            id: id?.kind === "id" ? id.value : null,
            deps: deps?.kind === "deps" ? deps.ids : null,
          });
        }
      }
      if (ops[0]?.role === "reg") regState.set(ops[0].value, undefined);
      continue;
    }

    if (ops.length > 0 && ops[0]!.role === "reg") {
      regState.set(ops[0]!.value, undefined);
    }
  }

  return modules;
}

/**
 * Number a scan's registrations. Numeric ids pass through. String ids (a
 * custom Metro `createModuleIdFactory`; corpus a10 registers all 4688 modules
 * under 8-hex-digit string hashes) get synthetic ids: the ordinal of the id's
 * first registration among string-id registrations, so 0, 1, 2, ... in
 * registration order. The export harness's original-side prelude numbers
 * string ids the same way at runtime (`__d` call order), so both sides of a
 * boot comparison agree. A dep naming an unregistered string id stays null.
 */
function numberRegistrations(raw: readonly RawRegistration[]): ModuleRegistration[] {
  const map = new Map<string, number>();
  for (const r of raw) if (typeof r.id === "string" && !map.has(r.id)) map.set(r.id, map.size);
  const num = (v: number | string | null): number | null => (typeof v === "string" ? (map.get(v) ?? null) : v);
  return raw.map((r) => {
    const depIds = r.deps === null ? null : r.deps.map(num);
    return {
      factoryFunctionIndex: r.factoryFunctionIndex,
      moduleId: num(r.id),
      depCount: depIds === null ? null : depIds.length,
      // Elements that resolve to no id stay null (as for a non-numeric
      // literal in a numeric-id bundle, unchanged).
      depIds: depIds as readonly number[] | null,
      ...(typeof r.id === "string" ? { moduleKey: r.id } : {}),
    };
  });
}

/** The string-id -> synthetic-id table `numberRegistrations` uses, for
 *  callers that meet a raw string id elsewhere (the global function's
 *  `__r("<id>")` startup calls). Empty for a numeric-id bundle. */
export function stringModuleIdMap(regs: readonly ModuleRegistration[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of regs) if (r.moduleKey !== undefined && r.moduleId !== null && !map.has(r.moduleKey)) map.set(r.moduleKey, r.moduleId);
  return map;
}

/**
 * Every module registration in the bundle. The global function (index 0) is
 * scanned first; only when it registers nothing are the functions it creates
 * directly (one level) scanned too. That covers the two corpus-B4 shapes: a
 * bundle body wrapped in an IIFE (registrations in function 1) and a lazy
 * definer `(id) => { switch (id) { case N: __d(factory, N); return; } }`
 * created by the global function. A normal bundle's children are its module
 * factories, which are never scanned, so its inventory is unchanged.
 */
export function scanBundleRegistrations(mod: HbcModule, decode: (mod: HbcModule, index: number) => DecodedFunction): ModuleRegistration[] {
  if (mod.functions.length === 0) return [];
  const globalFn = decode(mod, 0);
  const top = scanRaw(mod, globalFn);
  if (top.length > 0) return numberRegistrations(top);
  const children: number[] = [];
  const seen = new Set<number>([0]);
  for (const insn of globalFn.instructions) {
    for (const op of insn.operands) {
      if (op.role === "function" && !seen.has(op.value) && op.value < mod.functions.length) {
        seen.add(op.value);
        children.push(op.value);
      }
    }
  }
  const out: RawRegistration[] = [];
  for (const idx of children) out.push(...scanRaw(mod, decode(mod, idx)));
  return numberRegistrations(out);
}
