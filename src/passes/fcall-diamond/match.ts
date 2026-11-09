// fcall-diamond matcher — docs/specs/passes/04-call-shape.md section 10 (R3g).
//
// From v98, hermesc lowers `F.call(T, a...)` to a diamond:
//
//   B:  C = GetById F, "call"; ...; JmpBuiltinIs Lfast, <functionPrototypeCall>, C
//   S2: (generic) <arg loads>; CallN+1 Y, C, F, T, a...; Jmp J
//   S1: (fast)    <arg loads>; CallN   X, F, T, a...;    [Jmp J]
//   J:  ...
//
// The decompiler prints it as `if (C === __hbc_b_functionPrototypeCall)
// {fast} generic`, which recompiles to something else entirely. This rung
// annotates the `if` so the emitter prints only its generic arm, so the
// generic call is all that is left, and `call-shape` R3b then prints it as
// `F.call(T, a...)` — which hermesc compiles back to the same diamond.

import type { Stmt } from "../../structure/ir.ts";
import type { Match, PassContext } from "../types.ts";
import { argSlotBaseFor, hasDestOperand0, writtenRegisters, blocksMultiset, blocksOf, builtinNameFor, registerLiveAfter } from "../tree.ts";
import type { BlockId } from "../tree.ts";
import type { StructuredFunction } from "../../structure/ir.ts";
import type { Instruction } from "../tree.ts";
import { applyCallsCorrespond, callsCorrespond, evalArm, mismatchedRegisters } from "./diamond.ts";

export type IfNode = Stmt & { readonly k: "if" };

export interface FcallSite {
  readonly node: IfNode;
  /** The arm that holds the fast path and is deleted. */
  readonly drop: "then" | "else";
  readonly fast: BlockId;
  readonly generic: BlockId;
  /** Which builtin the diamond tests: `F.call(...)` or `F.apply(T, arguments)`. */
  readonly kind: "call" | "apply";
}

export type FcallMatch = Match<Stmt, FcallSite>;

export function match(node: Stmt, ctx: PassContext): FcallMatch | null {
  if (node.k !== "if" || node.keepOnly !== undefined) return null; // PL-08 latch
  const site = analyse(node, ctx);
  if (site === null) return null;
  if (typeof site === "string") {
    ctx.refuse?.(node, site);
    return null;
  }
  const offset = ctx.structured?.graph.cfg.blocks[node.cfgBlock]?.start ?? 0;
  return { root: node, nodes: [node], data: site, at: { functionIndex: ctx.functionIndex, offset } };
}

/** `null` = not this idiom; a string = this idiom, refused for that reason. */
export function analyse(node: IfNode, ctx: PassContext): FcallSite | string | null {
  const fn = ctx.structured;
  if (fn === undefined) return null;
  const cfg = fn.graph.cfg;
  const b = cfg.blocks[node.cfgBlock];
  const last = b?.instructions[b.instructions.length - 1];
  if (b === undefined || last === undefined) return null;
  const base = last.name.endsWith("Long") ? last.name.slice(0, -4) : last.name;
  if (base !== "JmpBuiltinIs" && base !== "JmpBuiltinIsNot") return null;
  const tested_builtin = builtinNameFor(ctx, last.operands[1]!.value);
  const kind = tested_builtin === "functionPrototypeCall" ? "call" : tested_builtin === "functionPrototypeApply" ? "apply" : null;
  if (kind === null) return null;
  const tested = last.operands[2]!.value;

  const taken = b.succs.find((e) => e.kind === "branch-taken")?.to;
  const notTaken = b.succs.find((e) => e.kind === "branch-not-taken")?.to;
  if (taken === undefined || notTaken === undefined || taken === notTaken || b.succs.length !== 2) return "branch-shape";
  const fast = base === "JmpBuiltinIs" ? taken : notTaken;
  const generic = base === "JmpBuiltinIs" ? notTaken : taken;

  // CFG obligations: two private arms meeting at one join, same handlers.
  const s1 = cfg.blocks[fast]!;
  const s2 = cfg.blocks[generic]!;
  if (s1.preds.length !== 1 || s2.preds.length !== 1 || s1.isHandlerEntry || s2.isHandlerEntry) return "arm-shared";
  if (s1.succs.length !== 1 || s2.succs.length !== 1) return "arm-exit";
  const join = s1.succs[0]!.to;
  if (s2.succs[0]!.to !== join || join === fast || join === generic) return "no-common-join";
  const h1 = cfg.exceptionSuccs.get(fast) ?? [];
  const h2 = cfg.exceptionSuccs.get(generic) ?? [];
  if (h1.length !== h2.length || h1.some((h, i) => h !== h2[i])) return "arm-handlers-differ";

  // The two calls are the Function.prototype.call pair.
  const argBase = argSlotBaseFor(ctx);
  const opts = { reify: kind === "apply" };
  const fa = evalArm(s1.instructions, argBase, opts);
  if (typeof fa === "string") return fa;
  const ga = evalArm(s2.instructions, argBase, opts);
  if (typeof ga === "string") return ga;
  if (kind === "call") {
    const why = callsCorrespond(fa.call, ga.call, tested);
    if (why !== null) return why;
  } else {
    const aa = builtinIndex(ctx, "applyArguments");
    if (aa === null) return "no-applyArguments-builtin";
    const why = applyCallsCorrespond(fa.call, ga.call, tested, aa);
    if (why !== null) return why;
    const genCall = s2.instructions.filter((i) => i.name !== "Jmp" && i.name !== "JmpLong").at(-1)!;
    if (genCall.name !== "Call3") return "apply-generic-not-Call3";
    const whyArgs = argumentsObjectPrivate(fn.graph.cfg, genCall, genCall.operands[4]!.value, argBase);
    if (whyArgs !== null) return whyArgs;
  }

  // Liveness: after the rewrite every execution takes the generic arm, so a
  // register the arms leave different must be dead where it is next observed —
  // at the join, and (pre-call state) at every handler.
  for (const r of mismatchedRegisters(fa.writes, ga.writes)) if (registerLiveAfter(fn, join, 0, r)) return "live-at-join";
  for (const h of h1) for (const r of mismatchedRegisters(fa.preCall, ga.preCall)) if (registerLiveAfter(fn, h, 0, r)) return "live-at-handler";

  // Tree obligations: the fast block appears exactly once, alone in one arm.
  const drop = armHolding(node, fast);
  if (drop === null) return "fast-arm-not-isolated";
  if ((blocksMultiset(fn.root).get(fast) ?? 0) !== 1) return "fast-block-duplicated";
  if ((blocksMultiset(drop === "then" ? node.else : node.then).get(fast) ?? 0) !== 0) return "fast-arm-not-isolated";
  return { node, drop, fast, generic, kind };
}

function builtinIndex(ctx: PassContext, name: string): number | null {
  for (let n = 0; n < 256; n++) {
    const got = builtinNameFor(ctx, n);
    if (got === name) return n;
    if (got === null) return null;
  }
  return null;
}

const ARG_WINDOW_CALLS = new Set(["Call", "CallLong", "Construct", "ConstructLong", "CallBuiltin", "CallBuiltinLong", "CallWithNewTarget", "CallWithNewTargetLong"]);

const isReify = (insn: Instruction): boolean => insn.name === "ReifyArgumentsLoose" || insn.name === "ReifyArgumentsStrict";

/** Does `insn` read register `a` (explicitly, or through a long-form call's
 *  implicit outgoing-argument window `argBase .. argBase - argc + 1`)? */
function readsReg(insn: Instruction, a: number, argBase: number): boolean {
  const ops = insn.operands;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.role !== "reg" || ops[i]!.value !== a) continue;
    if (i === 0 && hasDestOperand0(insn)) continue; // destination only
    return true;
  }
  if (ARG_WINDOW_CALLS.has(insn.name)) {
    const argc = ops[2]?.value ?? 0;
    if (a <= argBase && a > argBase - argc) return true;
  }
  return false;
}

type Cfg = StructuredFunction["graph"]["cfg"];

/** The `apply` diamond's side condition (section 10): the arguments object
 *  the generic arm passes is unmodified, so its array-like view is the
 *  frame's actual arguments, exactly what `applyArguments` copies. Proven on
 *  the whole function's CFG: from every `ReifyArguments* A`, every forward
 *  path (exception edges included) reaches no read of A, until A is
 *  overwritten, other than another `ReifyArguments* A` (which keeps the same
 *  object) and this one generic call. The object therefore never reaches
 *  code that could write it (Hermes never writes a frame's argument slots;
 *  `LoadParam` copies them out). */
function argumentsObjectPrivate(cfg: Cfg, genCall: Instruction, a: number, argBase: number): string | null {
  const seen = new Set<string>();
  const walk = (b: number, from: number): string | null => {
    const key = `${b}:${from}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const bb = cfg.blocks[b];
    if (bb === undefined) return "arguments-object-unknown-flow";
    for (let i = from; i < bb.instructions.length; i++) {
      const insn = bb.instructions[i]!;
      if (isReify(insn) && insn.operands[0]!.value === a) continue;
      if (insn !== genCall && readsReg(insn, a, argBase)) return "arguments-object-escapes";
      if (writtenRegisters(insn).includes(a)) return null; // the object is gone on this path
    }
    for (const s of [...bb.succs.map((e) => e.to), ...(cfg.exceptionSuccs.get(b) ?? [])]) {
      const why = walk(s, 0);
      if (why !== null) return why;
    }
    return null;
  };
  for (let b = 0; b < cfg.blocks.length; b++) {
    const insns = cfg.blocks[b]!.instructions;
    for (let i = 0; i < insns.length; i++) {
      if (!isReify(insns[i]!) || insns[i]!.operands[0]!.value !== a) continue;
      const why = walk(b, i + 1);
      if (why !== null) return why;
    }
  }
  return null;
}

function armHolding(node: IfNode, fast: BlockId): "then" | "else" | null {
  for (const side of ["then", "else"] as const) {
    const arm = node[side];
    const blocks = blocksOf(arm);
    if (blocks.length === 1 && blocks[0] === fast && onlyBlockAndJumps(arm)) return side;
  }
  return null;
}

/** The fast arm prints only its block and a jump to the join: nothing else
 *  (a `setState`, a nested statement) may disappear with it. */
function onlyBlockAndJumps(s: Stmt): boolean {
  if (s.k === "block" || s.k === "break") return true;
  if (s.k === "seq") return s.body.every(onlyBlockAndJumps);
  return false;
}

