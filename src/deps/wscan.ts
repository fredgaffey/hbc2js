// src/deps/wscan.ts — Re.Pack/webpack module-object recovery, and the
// bundle-kind decision (docs/specs/32-webpack-inventory.md).
//
// A webpack bundle has no `__d`. A chunk pushes `[[chunkIds], {id: factory}]`
// onto `self.webpackChunk_<name>`; the main runtime keeps the same
// integer-keyed object of factories in its IIFE. Hermes builds that object
// with `NewObject*` followed by one by-index store per entry
// (`PutOwnByIndex[L]` / `DefineOwnByIndex[L]`, or a by-value store with a
// numeric constant key past uint32). An object counts only when every
// by-index store into it is a fresh closure; the whole scanner runs only
// when Metro's `__d` scan found nothing and the string table names a
// `webpackChunk` global. Derived from observed hermesc output, not from
// any other decompiler.

import type { HbcModule } from "../parse/types.ts";
import type { DecodedFunction } from "../disasm/decode.ts";
import { scanBundleRegistrations } from "./dscan.ts";
import type { ModuleRegistration } from "./dscan.ts";

export type BundleKind = "metro" | "webpack" | "none";

const CREATE_CLOSURE = new Set(["CreateClosure", "CreateClosureLongIndex"]);
const BY_INDEX = new Set(["PutOwnByIndex", "PutOwnByIndexL", "DefineOwnByIndex", "DefineOwnByIndexL"]);
const BY_VAL = new Set(["PutOwnByVal", "DefineOwnByVal"]);
const NUMERIC_CONST = new Set(["LoadConstZero", "LoadConstUInt8", "LoadConstInt", "LoadConstDouble"]);
const CALL_WITH_ARG = new Set(["Call2", "Call3", "Call4"]);

type Reg = { kind: "closure"; fn: number } | { kind: "object"; alloc: number } | { kind: "num"; value: number } | { kind: "require" } | undefined;

interface ModuleObject {
  bad: boolean;
  entries: { id: number; fn: number }[];
}

/** Stores, jumps and returns read their first register operand. */
function writesFirstOperand(name: string): boolean {
  return !/^(Put|Define|Store|Jmp|J[A-Z]|Ret|Throw|Switch)/.test(name);
}

function constValue(insn: DecodedFunction["instructions"][number]): number | null {
  if (insn.name === "LoadConstZero") return 0;
  const v = insn.operands[1]?.value;
  return typeof v === "number" ? v : null;
}

function directChildren(mod: HbcModule, fn: DecodedFunction, seen: Set<number>): number[] {
  const out: number[] = [];
  for (const insn of fn.instructions) {
    for (const op of insn.operands) {
      if (op.role === "function" && !seen.has(op.value) && op.value < mod.functions.length) {
        seen.add(op.value);
        out.push(op.value);
      }
    }
  }
  return out;
}

/** Module objects built in one function: every all-closure, integer-keyed
 *  object literal, in store order. */
function scanModuleObjects(fn: DecodedFunction): { id: number; fn: number }[] {
  const regs = new Map<number, Reg>();
  const objects: ModuleObject[] = [];
  for (const insn of fn.instructions) {
    const ops = insn.operands;
    const dst = ops[0]?.role === "reg" ? ops[0].value : undefined;
    if (insn.name.startsWith("NewObject") && dst !== undefined) {
      objects.push({ bad: false, entries: [] });
      regs.set(dst, { kind: "object", alloc: objects.length - 1 });
      continue;
    }
    if (CREATE_CLOSURE.has(insn.name) && dst !== undefined) {
      const fnOp = ops.find((o) => o.role === "function");
      regs.set(dst, fnOp !== undefined ? { kind: "closure", fn: fnOp.value } : undefined);
      continue;
    }
    if (NUMERIC_CONST.has(insn.name) && dst !== undefined) {
      const value = constValue(insn);
      regs.set(dst, value !== null ? { kind: "num", value } : undefined);
      continue;
    }
    if (BY_INDEX.has(insn.name) || BY_VAL.has(insn.name)) {
      // Stores write no register: [object, value, key].
      const obj = regs.get(ops[0]!.value);
      if (obj?.kind !== "object") continue;
      const target = objects[obj.alloc]!;
      const val = regs.get(ops[1]!.value);
      let id: number | null = null;
      if (BY_INDEX.has(insn.name)) id = ops[2]?.value ?? null;
      else {
        const key = ops[2]?.role === "reg" ? regs.get(ops[2].value) : undefined;
        id = key?.kind === "num" && Number.isInteger(key.value) && key.value >= 0 ? key.value : null;
      }
      if (val?.kind === "closure" && id !== null) target.entries.push({ id, fn: val.fn });
      else target.bad = true;
      continue;
    }
    if (insn.name === "Mov" && dst !== undefined && ops[1]?.role === "reg") {
      regs.set(dst, regs.get(ops[1].value));
      continue;
    }
    if (dst !== undefined && writesFirstOperand(insn.name)) {
      regs.set(dst, undefined);
    }
  }
  return objects.filter((o) => !o.bad && o.entries.length > 0).flatMap((o) => o.entries);
}

/** Numeric first arguments of calls through the factory's third parameter
 *  (`__webpack_require__`), in call order, de-duplicated. */
export function webpackFactoryDeps(fn: DecodedFunction): number[] {
  const regs = new Map<number, Reg>();
  const deps: number[] = [];
  for (const insn of fn.instructions) {
    const ops = insn.operands;
    const dst = ops[0]?.role === "reg" ? ops[0].value : undefined;
    if (insn.name === "LoadParam" && dst !== undefined) {
      regs.set(dst, ops[1]?.value === 3 ? { kind: "require" } : undefined);
      continue;
    }
    if (NUMERIC_CONST.has(insn.name) && dst !== undefined) {
      const value = constValue(insn);
      regs.set(dst, value !== null ? { kind: "num", value } : undefined);
      continue;
    }
    if (insn.name === "Mov" && dst !== undefined && ops[1]?.role === "reg") {
      regs.set(dst, regs.get(ops[1].value));
      continue;
    }
    if (CALL_WITH_ARG.has(insn.name) && ops.length >= 4) {
      const callee = regs.get(ops[1]!.value);
      const arg = regs.get(ops[3]!.value);
      if (callee?.kind === "require" && arg?.kind === "num" && !deps.includes(arg.value)) deps.push(arg.value);
    }
    if (dst !== undefined && writesFirstOperand(insn.name)) {
      regs.set(dst, undefined);
    }
  }
  return deps;
}

function hasWebpackChunkGlobal(mod: HbcModule): boolean {
  for (let i = 0; i < mod.strings.count; i++) {
    if (mod.strings.get(i).startsWith("webpackChunk")) return true;
  }
  return false;
}

/** Webpack module registrations: module objects in `global` and in the
 *  functions it creates directly (the main runtime's IIFE). */
export function scanWebpackRegistrations(mod: HbcModule, decode: (mod: HbcModule, index: number) => DecodedFunction): ModuleRegistration[] {
  if (mod.functions.length === 0) return [];
  const globalFn = decode(mod, 0);
  const fns = [0, ...directChildren(mod, globalFn, new Set([0]))];
  const out: ModuleRegistration[] = [];
  const taken = new Set<number>();
  for (const idx of fns) {
    for (const e of scanModuleObjects(idx === 0 ? globalFn : decode(mod, idx))) {
      if (taken.has(e.fn) || e.fn >= mod.functions.length) continue;
      taken.add(e.fn);
      const depIds = webpackFactoryDeps(decode(mod, e.fn));
      out.push({ factoryFunctionIndex: e.fn, moduleId: e.id, depCount: depIds.length, depIds });
    }
  }
  return out;
}

/** The bundle's module system and its registrations: Metro `__d` first (a
 *  Metro inventory never changes), then webpack only when a `webpackChunk`
 *  global is named. */
export function scanBundle(mod: HbcModule, decode: (mod: HbcModule, index: number) => DecodedFunction): { kind: BundleKind; registrations: ModuleRegistration[] } {
  const metro = scanBundleRegistrations(mod, decode);
  if (metro.length > 0) return { kind: "metro", registrations: metro };
  if (hasWebpackChunkGlobal(mod)) {
    const wp = scanWebpackRegistrations(mod, decode);
    if (wp.length > 0) return { kind: "webpack", registrations: wp };
  }
  return { kind: "none", registrations: [] };
}
