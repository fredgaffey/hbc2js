// fcall-diamond: the arm-equivalence proof — docs/specs/passes/04-call-shape.md
// section 8 (R3g). Pure over instruction lists so the unit tests can drive it
// with hand-built arms; `match.ts` adds the CFG and liveness obligations.
//
// Each arm is evaluated symbolically: a register the arm has not written
// holds `in:<r>` (its value at the arm's entry, identical for both arms since
// they share the predecessor), a constant load holds its opcode + operands, a
// `Mov` copies, and the call's result is the token `RESULT`. Anything else in
// an arm refuses the site: a non-modelled instruction could have an effect the
// other arm does not repeat.
import type { Instruction } from "../tree.ts";

export type Sym = string;

export interface ArmCall {
  readonly dst: number;
  readonly callee: Sym;
  /** Logical arguments, `this` first. */
  readonly args: readonly Sym[];
}

export interface ArmValue {
  readonly call: ArmCall;
  /** Final value of every register the arm writes (the call's `dst` = `RESULT`). */
  readonly writes: ReadonlyMap<number, Sym>;
  /** Value of every register written before the call (what an exception handler sees). */
  readonly preCall: ReadonlyMap<number, Sym>;
}

export const UNDEF: Sym = "undef";

const FIXED_CALLS: Readonly<Record<string, number>> = { Call1: 1, Call2: 2, Call3: 3, Call4: 4 };

function isJump(name: string): boolean {
  return name === "Jmp" || name === "JmpLong";
}

/** Symbolic evaluation of one arm. `argBase` is `argSlotBase(version, frameSize)`
 *  (the register holding `arg[0]` of a long-form `Call`). Returns a refusal
 *  reason string when the arm is not a modelled shape. */
export function evalArm(insns: readonly Instruction[], argBase: number): ArmValue | string {
  let end = insns.length;
  if (end > 0 && isJump(insns[end - 1]!.name)) end--;
  if (end === 0) return "arm-no-call";
  const regs = new Map<number, Sym>();
  const val = (r: number): Sym => regs.get(r) ?? `in:${r}`;
  for (let i = 0; i < end - 1; i++) {
    const insn = insns[i]!;
    const ops = insn.operands;
    const d = ops[0]?.value;
    if (d === undefined || ops[0]!.role !== "reg") return `arm-insn:${insn.name}`;
    if (insn.name === "LoadConstUndefined") regs.set(d, UNDEF);
    else if (insn.name.startsWith("LoadConst")) regs.set(d, `${insn.name}(${ops.slice(1).map((o) => o.value).join(",")})`);
    else if (insn.name === "Mov" || insn.name === "MovLong") regs.set(d, val(ops[1]!.value));
    else return `arm-insn:${insn.name}`;
  }
  const preCall = new Map(regs);
  const c = insns[end - 1]!;
  const ops = c.operands;
  let args: Sym[];
  const fixed = FIXED_CALLS[c.name];
  if (fixed !== undefined) {
    if (ops.length !== 2 + fixed) return "arm-call-operands";
    args = ops.slice(2).map((o) => val(o.value));
  } else if (c.name === "Call" || c.name === "CallLong") {
    const argc = ops[2]!.value;
    if (argc < 1 || argBase - (argc - 1) < 0) return "arm-call-argc";
    args = [];
    for (let i = 0; i < argc; i++) args.push(val(argBase - i));
  } else {
    return `arm-last:${c.name}`;
  }
  const dst = ops[0]!.value;
  const callee = val(ops[1]!.value);
  regs.set(dst, "RESULT");
  return { call: { dst, callee, args }, writes: regs, preCall };
}

/** ES2024 20.2.3.3 `Function.prototype.call(thisArg, ...args)`: when the
 *  generic arm's callee is the builtin `call` (what `JmpBuiltinIs` tested),
 *  `generic` = `Call(call, F, [T, a...])` performs `Call(F, T, [a...])`, which
 *  is `fast`. Proves the two calls are that pair: the generic callee is the
 *  tested register's entry value, the generic `this` is the fast callee, and
 *  the remaining argument lists line up (a missing `thisArg` is `undefined`). */
export function callsCorrespond(fast: ArmCall, generic: ArmCall, testedReg: number): string | null {
  if (generic.callee !== `in:${testedReg}`) return "generic-callee-not-tested";
  if (generic.args.length < 1) return "generic-no-this";
  if (generic.args[0] !== fast.callee) return "this-not-fast-callee";
  const genRest = generic.args.slice(1);
  const want = genRest.length === 0 ? [UNDEF] : genRest;
  if (fast.args.length !== want.length) return "arg-count";
  for (let i = 0; i < want.length; i++) if (fast.args[i] !== want[i]) return `arg-${i}`;
  return null;
}

/** Registers whose value differs between the two arms after `pick` (writes or
 *  preCall): the candidates the CFG liveness check must prove dead. */
export function mismatchedRegisters(a: ReadonlyMap<number, Sym>, b: ReadonlyMap<number, Sym>): number[] {
  const out: number[] = [];
  for (const r of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(r) ?? `in:${r}`) !== (b.get(r) ?? `in:${r}`)) out.push(r);
  }
  return out.sort((x, y) => x - y);
}
