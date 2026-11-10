// src/split/entry.ts — find the Metro entry module id from the bundle's
// global function: the last `<globalObj>.__r(<literal id>)` call (Metro's
// `require(entryId)`, run after every `__d()` registration). Best-effort,
// top-level statements only — see src/split/tag.ts's header comment.
import type { Expr, Stmt } from "../emit/ast.ts";
import { classify, isReflectApply, type Tag } from "./tag.ts";
import type { FunctionCfg } from "../cfg/types.ts";
import type { Instruction } from "../disasm/decode.ts";
import { writtenRegisters } from "../cfg/reg-effects.ts";

type RegVal = number | "top";
const constLoaded = (insn: Instruction): RegVal => {
  if (insn.name === "LoadConstZero") return 0;
  if (/^LoadConst(UInt8|Int|Double)$/.test(insn.name)) {
    const v = insn.operands[1]?.value;
    return typeof v === "number" && Number.isInteger(v) ? v : "top";
  }
  return "top";
};

/** The integer constant register `reg` holds on every path reaching the
 *  last instruction before `end` in the function `cfg`, or undefined when a
 *  path brings anything else (a forward reaching-definitions pass over the
 *  bytecode CFG; a handler entry starts unknown). The AST scan cannot tell a
 *  write under a structured `if` that every path still crosses from a truly
 *  conditional one: Expensify's fn#0 writes r3 = 65535, then 0 on both arms
 *  of a branch, and the final `__r(r3)` must read 0 (export-boot apps). */
export function constRegisterBefore(cfg: FunctionCfg, end: number, reg: number): number | undefined {
  let at: { block: number; index: number } | undefined;
  for (const b of cfg.blocks) b.instructions.forEach((insn, i) => {
    if (insn.offset < end && (at === undefined || insn.offset > cfg.blocks[at.block]!.instructions[at.index]!.offset)) at = { block: b.id, index: i };
  });
  if (at === undefined) return undefined;
  const join = (a: RegVal | undefined, b: RegVal): RegVal => (a === undefined ? b : a === b ? a : "top");
  const inState = new Map<number, RegVal>();
  const flow = (id: number, v: RegVal, upTo = Infinity): RegVal => {
    const ins = cfg.blocks[id]!.instructions;
    for (let i = 0; i < Math.min(ins.length, upTo); i++) if (writtenRegisters(ins[i]!).includes(reg)) v = constLoaded(ins[i]!);
    return v;
  };
  // Before the entry block runs, a register is undefined: not an id.
  inState.set(cfg.entry, "top");
  for (const b of cfg.blocks) if (b.isHandlerEntry) inState.set(b.id, "top");
  const work = [...inState.keys()];
  while (work.length > 0) {
    const id = work.pop()!;
    const out = flow(id, inState.get(id)!);
    for (const e of cfg.blocks[id]!.succs) {
      const next = join(inState.get(e.to), out);
      if (next !== inState.get(e.to)) { inState.set(e.to, next); work.push(e.to); }
    }
  }
  const v0 = inState.get(at.block);
  if (v0 === undefined) return undefined;
  const v = flow(at.block, v0, at.index);
  return v === "top" ? undefined : v;
}

/** Registers that every assignment in the global function's own code (nested
 *  blocks included, nested functions excluded) sets to one and the same
 *  integer literal. hermesc -O materialises a constant into a register once,
 *  possibly inside a labelled block, and reads it at top level much later —
 *  the entry id `0` of a Metro bundle's final `__r(0)` is the case that matters
 *  (export-boot L4). A register with any other or differing assignment is left
 *  out. */
function singleConstRegisters(globalBody: readonly Stmt[]): Map<string, number> {
  const fnOf = (s: Stmt): number | undefined => (s as { readonly origin?: { readonly fn?: number } }).origin?.fn;
  const own = globalBody.map(fnOf).find((f) => f !== undefined);
  // Writes in document order, each marked conditional when it sits under
  // anything but plain/labelled blocks (an if, loop, try, switch arm).
  // hermesc -O reuses the register: Expensify's r3 is first a module id
  // (65535) and only later the entry id 0. Every write is unconditional
  // there, so the last one is the value the final `__r(r3)` reads
  // (export-boot apps). A conditional write of a different value leaves
  // the register unresolved.
  const writes = new Map<string, { v: number | "mixed"; cond: boolean }[]>();
  const visit = (stmts: readonly unknown[], cond: boolean): void => {
    for (const x of stmts) {
      if (x === null || typeof x !== "object" || typeof (x as { k?: unknown }).k !== "string") continue;
      const st = x as Stmt;
      if (fnOf(st) !== undefined && fnOf(st) !== own) continue;
      const at = assignedIdent(st);
      if (at !== null) {
        const v = at.value.k === "lit" && /^-?\d+$/.test(at.value.text) ? Number(at.value.text) : "mixed";
        const list = writes.get(at.name) ?? [];
        list.push({ v, cond });
        writes.set(at.name, list);
        continue;
      }
      if (st.k === "expr" || st.k === "init") continue;
      const inner = cond || st.k !== "labeled";
      for (const val of Object.values(st as object)) {
        if (Array.isArray(val)) visit(val, inner);
        else if (val !== null && typeof val === "object" && typeof (val as { k?: unknown }).k === "string" && !("expr" in st && val === (st as { expr?: unknown }).expr)) visit([val], inner);
      }
    }
  };
  visit(globalBody, false);
  const out = new Map<string, number>();
  for (const [name, list] of writes) {
    const last = list[list.length - 1]!;
    if (last.v === "mixed") continue;
    if (list.some((w) => w.v !== last.v && (w.cond || last.cond))) continue;
    out.set(name, last.v);
  }
  return out;
}
function assignedIdent(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

export function resolveEntryModuleId(globalBody: readonly Stmt[], cfg?: FunctionCfg): number | null {
  const ids = resolveStartupModuleIds(globalBody, cfg);
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}

/** Every top-level `<globalObj>.__r(<literal id>)` call, in order: Metro's
 *  run-before-main modules (e.g. RN's InitializeCore) followed by the entry
 *  module (spec 33 L1: an export must run all of them, not just the last). */
export function resolveStartupModuleIds(globalBody: readonly Stmt[], cfg?: FunctionCfg): number[] {
  const regs = new Map<string, Tag>();
  const noParams = new Set<string>();
  const ids: number[] = [];
  let consts: Map<string, number> | undefined;

  const checkCall = (call: Extract<Expr, { k: "call" }>, at: Stmt): void => {
    if (!isReflectApply(call.callee) || call.args.length !== 3) return;
    const fnTag = classify(call.args[0]!, regs, noParams);
    if (!(fnTag.kind === "prop" && fnTag.name === "__r")) return;
    const arr = call.args[2]!;
    if (arr.k !== "array" || arr.elements.length !== 1) return;
    // A register argument: its writes across the whole global body (nested
    // blocks included) decide, not just the top-level ones `regs` saw.
    if (arr.elements[0]!.k === "ident") {
      // With the bytecode CFG at hand, the register's reaching value decides.
      const reg = /^r(\d+)$/.exec(arr.elements[0]!.name);
      const origin = (at as { readonly origin?: { readonly end?: number } }).origin;
      if (cfg !== undefined && reg !== null && origin?.end !== undefined) {
        const v = constRegisterBefore(cfg, origin.end, Number(reg[1]));
        if (v !== undefined) { ids.push(v); return; }
      }
      consts ??= singleConstRegisters(globalBody);
      const v = consts.get(arr.elements[0]!.name);
      if (v !== undefined) { ids.push(v); return; }
    }
    const argTag = classify(arr.elements[0]!, regs, noParams);
    if (argTag.kind === "num") ids.push(argTag.value);
  };

  for (const s of globalBody) {
    const at = assignedIdent(s);
    if (at !== null) {
      if (at.value.k === "call") {
        checkCall(at.value, s);
        regs.set(at.name, { kind: "other" });
      } else {
        regs.set(at.name, classify(at.value, regs, noParams));
      }
      continue;
    }
    if (s.k === "expr" && s.expr.k === "call") checkCall(s.expr, s);
  }
  return ids;
}
