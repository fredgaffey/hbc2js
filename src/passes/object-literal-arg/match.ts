// object-literal-arg matcher — docs/specs/passes/20-object-literal.md §9.
//
// `r7 = Object; obj = {enumerable: true, get: _fn2}; r7.defineProperty(r6, "x", obj)`
// back into `Object.defineProperty(r6, "x", {enumerable: true, get: _fn2})`.
//
// Two site kinds, both confined to two ADJACENT statements of one list:
//
//  A (literal into argument). `L[i]` is `rO = <inert object literal>` whose
//    origin is a fresh-object opcode, `L[i+1]` is a call statement with
//    `ident rO` as one of its direct arguments, and `rO` is single-use in the
//    function. Moves the allocation from before the whole call to its
//    argument slot. Sound because creating an inert literal (§9 "inert") is
//    unobservable and its inputs cannot change in between: nothing evaluated
//    before the slot (callee, earlier arguments) can see the fresh object
//    (its only reference is `rO`, read once, in the slot), and none of the
//    literal's inputs is something those evaluations could write — values are
//    literals, registers (frame-local, never reachable from a getter), or the
//    names of never-reassigned function declarations, and the callee/earlier
//    arguments are checked to assign none of them.
//
//  B (callee base). `L[i]` is `rC = E` (E an identifier or a non-computed
//    member chain over one), `L[i+1]` is a call statement whose callee is
//    `rC.m`, `rC` single-use. The callee's base is the FIRST thing the call
//    statement evaluates, so `E` is evaluated at exactly the same point of
//    the effect sequence after the move — this is expr-rebuild's own R1a
//    adjacent case (02-expr-rebuild.md §4), which could not fire earlier
//    because kind A's literal still stood between the two statements.
import { identUses, isRegisterName, opcodeAt, originOf, registerUses } from "../ast.ts";
import type { Expr, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

const FRESH_OBJECT: ReadonlySet<string> = new Set(["NewObject", "NewObjectWithBuffer", "NewObjectWithBufferLong"]);

export interface ArgInlineSite {
  readonly kind: "literal-arg" | "callee-base";
  readonly reg: string;
  readonly defIndex: number;
  /** The call statement the value moves into. */
  readonly useIndex: number;
  readonly value: Expr;
}
export type ArgInlineMatch = Match<readonly Stmt[], ArgInlineSite>;

function defOf(s: Stmt): { readonly reg: string; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident" || !isRegisterName(s.expr.target.name)) return null;
  return { reg: s.expr.target.name, value: s.expr.value };
}

/** The call a statement evaluates as its whole top-level work: `call(...)`,
 *  `rZ = call(...)` (ident target: evaluates nothing before the call),
 *  `return call(...)`, `let x = call(...)`. */
export function callOf(s: Stmt, memberTarget = false): Extract<Expr, { k: "call" }> | null {
  let e: Expr | null = null;
  if (s.k === "expr") e = s.expr.k === "assign" && (s.expr.target.k === "ident" || (memberTarget && plainMemberTarget(s.expr.target))) ? s.expr.value : s.expr;
  else if (s.k === "return") e = s.arg;
  else if (s.k === "init") e = s.value;
  return e !== null && e.k === "call" ? e : null;
}

/** Kind B only: `X.p = call(...)` with `X` a non-global identifier. The
 *  assignment evaluates the binding `X` (a frame-local or closure read, which
 *  runs no code) before the call, then the call, then the store; so the call's
 *  callee base is still the first effect of the statement (spec 05 section
 *  7.4: R3e's re-fused `rC.m(...)` lands here for `C.prototype = Object.create(...)`). */
function plainMemberTarget(t: Expr): boolean {
  return t.k === "member" && !t.computed && t.prop.k === "lit" && t.obj.k === "ident" && t.obj.global !== true;
}

export function withCall(s: Stmt, call: Expr): Stmt {
  if (s.k === "expr") return s.expr.k === "assign" && (s.expr.target.k === "ident" || plainMemberTarget(s.expr.target)) && s.expr.value.k === "call" ? { ...s, expr: { ...s.expr, value: call } } : { ...s, expr: call };
  if (s.k === "return") return { ...s, arg: call };
  if (s.k === "init") return { ...s, value: call };
  return s;
}

/** Names of the function declarations at the top of `fnBody` that are never
 *  assigned anywhere in it (reading one is effect-free and always yields the
 *  same closure). */
function stableFunctionNames(fnBody: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  for (const s of fnBody) {
    if (s.k !== "func") continue;
    if (identUses(fnBody, s.name).writes === 0) out.add(s.name);
  }
  return out;
}

/** §9 "inert": evaluating it runs no user code, cannot throw, and reads only
 *  values no other code can change in between. Collects the registers read. */
function inert(e: Expr, fns: ReadonlySet<string>, regs: string[]): boolean {
  switch (e.k) {
    case "lit":
    case "this":
      return true;
    case "ident":
      if (e.global === true) return false;
      if (isRegisterName(e.name)) {
        regs.push(e.name);
        return true;
      }
      return fns.has(e.name);
    case "array":
      return e.elements.every((x) => inert(x, fns, regs));
    case "object":
      return e.props.every((p) => !("k" in p) && !p.computed && p.key !== "__proto__" && p.key !== '"__proto__"' && inert(p.value, fns, regs));
    default:
      return false;
  }
}

function isBaseChain(e: Expr): boolean {
  if (e.k === "ident") return !isRegisterName(e.name);
  return e.k === "member" && !e.computed && e.prop.k === "lit" && isBaseChain(e.obj);
}

function singleUse(fnBody: readonly Stmt[], reg: string): boolean {
  const u = registerUses(fnBody).get(reg);
  return u !== undefined && u.reads === 1 && u.writes === 1 && u.nested === 0;
}

/** expr-rebuild's D-a (02-expr-rebuild.md section 4), local to `list`: after the
 *  use at `j`, `reg` is overwritten by a plain store before anything mentions
 *  it, and only straight-line statements lie in between. */
function rewrittenLater(list: readonly Stmt[], j: number, reg: string): boolean {
  for (let k = j + 1; k < list.length; k++) {
    const s = list[k]!;
    if (s.k === "comment" || s.k === "decl") continue;
    if (s.k !== "expr" && s.k !== "init") return false;
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) return identUses([{ k: "expr", expr: s.expr.value }], reg).reads === 0;
    const u = identUses([s], reg);
    if (u.reads + u.writes + u.nested > 0) return false;
  }
  return false;
}

/** The definition at `i` is the only value of `reg` the use at `i + 1` reads
 *  and nothing else reads it: D-b (whole function) or D-a (local). */
function deadAfterUse(list: readonly Stmt[], fnBody: readonly Stmt[], i: number, reg: string): boolean {
  return singleUse(fnBody, reg) || ((registerUses(fnBody).get(reg)?.nested ?? 0) === 0 && rewrittenLater(list, i + 1, reg));
}

const asStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });

export function match(list: readonly Stmt[], ctx: PassContext): ArgInlineMatch | null {
  const fnBody = ctx.fnBody;
  if (fnBody === undefined) return null;
  return literalArg(list, fnBody, ctx) ?? calleeBase(list, fnBody, ctx);
}

const atOf = (s: Stmt, ctx: PassContext) => ({ functionIndex: ctx.functionIndex, offset: originOf(s)?.start ?? 0 });

/** Kind A. */
function literalArg(list: readonly Stmt[], fnBody: readonly Stmt[], ctx: PassContext): ArgInlineMatch | null {
  let fns: Set<string> | null = null;
  for (let i = 0; i + 1 < list.length; i++) {
    const def = defOf(list[i]!);
    if (def === null || def.value.k !== "object") continue;
    const call = callOf(list[i + 1]!);
    if (call === null) continue;
    const slot = call.args.findIndex((a) => a.k === "ident" && a.name === def.reg);
    if (slot < 0 || identUses([list[i + 1]!], def.reg).reads !== 1) continue;
    const o = originOf(list[i]!);
    if (o === undefined || o.fn !== ctx.functionIndex || !FRESH_OBJECT.has(opcodeAt(ctx.cfg, o.start) ?? "")) continue;
    fns ??= stableFunctionNames(fnBody);
    const regs: string[] = [];
    if (!inert(def.value, fns, regs)) {
      ctx.refuse?.(list[i], "not-inert");
      continue;
    }
    if (regs.includes(def.reg) || !deadAfterUse(list, fnBody, i, def.reg)) continue;
    // Nothing evaluated before the slot may write what the literal reads.
    const before = [asStmt(call.callee), ...call.args.slice(0, slot).map(asStmt)];
    if ([...regs, ...fns].some((n) => identUses(before, n).writes > 0)) {
      ctx.refuse?.(list[i], "input-written-before-slot");
      continue;
    }
    return { root: list, nodes: [list], data: { kind: "literal-arg", reg: def.reg, defIndex: i, useIndex: i + 1, value: def.value }, at: atOf(list[i]!, ctx) };
  }
  return null;
}

/** A statement kind B may move `E` past: no value, or `rX = <literal or
 *  register>`. Nothing narrower than this commutes with `E`, which may run
 *  user code (a global getter, a getter on the chain): `isPureStmt` admits
 *  global reads (another getter, or a ReferenceError) and operators that call
 *  `valueOf`/`toString`, and a non-register target (a closure variable) the
 *  getter could read (review-1110 objlit/fold, fixture 330). */
function commutesWithGetter(s: Stmt): boolean {
  if (s.k === "comment" || s.k === "decl") return true;
  const d = defOf(s);
  return d !== null && (d.value.k === "lit" || (d.value.k === "ident" && d.value.global !== true && isRegisterName(d.value.name)));
}

/** Kind B: `rC = E` (E a global identifier or a member chain over one, so it
 *  reads no register), then only `commutesWithGetter` statements that never
 *  mention `rC`, then a call whose callee is `rC.m`. E is the first thing that
 *  call evaluates, and the skipped statements have no effect to commute with. */
function calleeBase(list: readonly Stmt[], fnBody: readonly Stmt[], ctx: PassContext): ArgInlineMatch | null {
  const mentions = (s: Stmt, reg: string): boolean => {
    const u = identUses([s], reg);
    return u.reads + u.writes + u.nested > 0;
  };
  for (let i = 0; i + 1 < list.length; i++) {
    const def = defOf(list[i]!);
    if (def === null || !isBaseChain(def.value)) continue;
    let j = i + 1;
    while (j < list.length && commutesWithGetter(list[j]!) && !mentions(list[j]!, def.reg)) j++;
    if (j >= list.length) continue;
    const call = callOf(list[j]!, true);
    if (call === null || call.callee.k !== "member" || call.callee.obj.k !== "ident" || call.callee.obj.name !== def.reg) continue;
    if (identUses([list[j]!], def.reg).reads !== 1 || !deadAfterUse(list, fnBody, j - 1, def.reg)) continue;
    return { root: list, nodes: [list], data: { kind: "callee-base", reg: def.reg, defIndex: i, useIndex: j, value: def.value }, at: atOf(list[i]!, ctx) };
  }
  return null;
}
