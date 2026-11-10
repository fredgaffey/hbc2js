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
//
//  C (slot fill in a sequence). Inside a sequence expression of one
//    top-level statement, `rN = {..., k: <inert>, ...}` immediately followed
//    by `rN.k = v` (v inert, k a plain data key the literal already owns)
//    becomes `rN = {..., k: v, ...}`; then `(..., rN = L, rN)` with `rN`
//    single-use becomes `(..., L)`. Hermes builds `{k: <non-constant>}` as a
//    NewObjectWithBuffer placeholder plus PutOwnBySlotIdx, and a value-context
//    branch (`d.get ? d : {get: f}`, a call argument) prints that fill as an
//    assignment, which recompiles to a PutById. Sound for ANY store opcode:
//    [[Set]] on an own writable data property of an ordinary object is
//    OrdinarySetWithOwnDescriptor's plain value update — it never consults
//    the prototype chain, runs no setter, and keeps the key's position — and
//    the fresh literal (no accessor, spread, computed or __proto__ key, by
//    `inert`) cannot have been altered in between (the two are adjacent).
//    Both values are inert, so dropping the placeholder and evaluating `v`
//    inside the literal reorders nothing observable.
//
//  D (closure into its literal slot). A top-level `function k() {...}` of
//    this function, never assigned, whose ONLY mention anywhere (its own
//    body included) is the value of a literal's plain `k:` property in a
//    statement of the same top-level list, moves into that slot as
//    `k: function () {...}`. Hermes creates a hoisted declaration's closure
//    before the literal that uses it, and an inline expression's after it
//    (NewObjectWithBuffer, CreateClosure, PutOwnBySlotIdx). Sound: creating
//    a closure is unobservable and nothing can name it before the slot (it
//    has no other reference); it captures the same function-level scope
//    (the slot is in the top-level list, so no block binding intervenes);
//    and its `name` stays `k` — an anonymous function expression as the
//    value of property `k` is named `k` (SetFunctionName).
import { identUses, identUsesMany, isRegisterName, isSafeIdentifier, mapExpr, mapStmts, opcodeAt, originOf, registerUses, walk } from "../ast.ts";
import type { Expr, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

const FRESH_OBJECT: ReadonlySet<string> = new Set(["NewObject", "NewObjectWithBuffer", "NewObjectWithBufferLong"]);

export interface ArgInlineSite {
  readonly kind: "literal-arg" | "callee-base" | "slot-fill" | "closure-slot";
  readonly reg: string;
  readonly defIndex: number;
  /** The call statement the value moves into. */
  readonly useIndex: number;
  readonly value: Expr;
  /** Kind C: the rewritten statement that replaces `list[defIndex]`. */
  readonly stmt?: Stmt;
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
 *  same closure). One `identUsesMany` walk for all of them, memoised per
 *  `fnBody` object (the driver hands every list of one iteration the same
 *  body): a walk per declaration, redone per matched list, was quadratic in
 *  a bundle's global function, whose declarations nest the whole bundle
 *  (closure-inline-hang). */
const stableMemo = new WeakMap<readonly Stmt[], Set<string>>();
export function stableFunctionNames(fnBody: readonly Stmt[]): Set<string> {
  const hit = stableMemo.get(fnBody);
  if (hit !== undefined) return hit;
  const names = fnBody.flatMap((s) => (s.k === "func" ? [s.name] : []));
  const uses = identUsesMany(fnBody, names);
  const out = new Set(names.filter((n) => uses.get(n)!.writes === 0));
  stableMemo.set(fnBody, out);
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
  return literalArg(list, fnBody, ctx) ?? calleeBase(list, fnBody, ctx) ?? slotFill(list, fnBody, ctx) ?? closureSlot(list, fnBody, ctx);
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

/** One kind-C step on a sequence's elements, or null. */
function fillSeq(exprs: readonly Expr[], dead: (reg: string) => boolean, fns: ReadonlySet<string>): Expr | null {
  for (let k = 0; k + 1 < exprs.length; k++) {
    const d = exprs[k]!;
    if (d.k !== "assign" || d.target.k !== "ident" || !isRegisterName(d.target.name) || d.value.k !== "object") continue;
    const reg = d.target.name;
    const lit = d.value;
    if (!inert(lit, fns, [])) continue;
    const st = exprs[k + 1]!;
    // `(..., rN = L, rN)` at the end, rN read nowhere else: just `L`.
    if (k + 2 === exprs.length && st.k === "ident" && st.name === reg && dead(reg)) {
      return exprs.length === 2 ? lit : { k: "seq", exprs: [...exprs.slice(0, k), lit] };
    }
    if (st.k !== "assign" || st.target.k !== "member" || st.target.computed || st.target.obj.k !== "ident" || st.target.obj.name !== reg) continue;
    if (st.target.prop.k !== "lit" || !isSafeIdentifier(st.target.prop.text) || st.target.prop.text === "__proto__") continue;
    const key = st.target.prop.text;
    const at = lit.props.flatMap((p, i) => (!("k" in p) && !p.computed && p.key === key ? [i] : []));
    if (at.length !== 1) continue;
    const regs: string[] = [];
    if (!inert(st.value, fns, regs) || regs.includes(reg)) continue;
    const props = lit.props.map((p, i) => (i === at[0] ? { key, computed: false, value: st.value } : p));
    const filled: Expr = { ...d, value: { ...lit, props } };
    return { k: "seq", exprs: [...exprs.slice(0, k), filled, ...exprs.slice(k + 2)] };
  }
  return null;
}

/** Kind C: the first top-level statement holding a fillable sequence. Nested
 *  function bodies are other sites (their own registers and declarations),
 *  so a statement containing a function or class expression is skipped. */
function slotFill(list: readonly Stmt[], fnBody: readonly Stmt[], ctx: PassContext): ArgInlineMatch | null {
  let fns: Set<string> | null = null;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.k !== "expr" && s.k !== "init" && s.k !== "return") continue;
    let hasSeq = false;
    let nested = false;
    walk([s], { expr: (e) => { if (e.k === "seq") hasSeq = true; else if (e.k === "func" || e.k === "class") nested = true; } });
    if (!hasSeq || nested) continue;
    fns ??= stableFunctionNames(fnBody);
    const f = fns;
    // `rN` is read only by the sequence's last element: written and read once
    // in this statement, and dead after it (D-b, or D-a local to `list`).
    const dead = (reg: string): boolean => {
      const here = identUses([s], reg);
      return here.reads === 1 && here.writes === 1 && here.nested === 0 && deadAfterUse(list, fnBody, i - 1, reg);
    };
    let done = false;
    const next = mapStmts([s], (x) => x, (e) => {
      if (done || e.k !== "seq") return e;
      const r = fillSeq(e.exprs, dead, f);
      if (r === null) return e;
      done = true;
      return r;
    });
    if (!done) continue;
    return { root: list, nodes: [list], data: { kind: "slot-fill", reg: "", defIndex: i, useIndex: i, value: { k: "lit", text: "0" }, stmt: next[0]! }, at: atOf(s, ctx) };
  }
  return null;
}

/** Kind D. */
function closureSlot(list: readonly Stmt[], fnBody: readonly Stmt[], ctx: PassContext): ArgInlineMatch | null {
  const module = ctx.module;
  if (list !== fnBody || module === undefined) return null;
  // `_fnN` -> the bytecode name of function N: the key the slot must have.
  const decls = new Map<string, number>();
  const keyOf = new Map<string, string>();
  list.forEach((s, i) => {
    const n = s.k === "func" ? /^_fn(\d+)$/.exec(s.name) : null;
    if (s.k === "func" && n !== null) {
      const key = module.functionName(Number(n[1]));
      if (!isSafeIdentifier(key)) return;
      keyOf.set(s.name, key);
      const u = identUses(fnBody, s.name);
      if (u.reads === 1 && u.writes === 0 && u.nested === 0) decls.set(s.name, i);
    }
  });
  if (decls.size === 0) return null;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.k === "func" || s.k === "comment" || s.k === "decl") continue;
    let hit: string | null = null;
    const intoSlot = (e: Expr): Expr => {
      if (hit !== null || e.k !== "object") return e;
      const at = e.props.findIndex((p) => !("k" in p) && !p.computed && p.value.k === "ident" && p.value.global !== true && decls.has(p.value.name) && keyOf.get(p.value.name) === p.key);
      if (at < 0) return e;
      const prop = e.props[at] as { key: string; value: Extract<Expr, { k: "ident" }> };
      const name = prop.value.name;
      const fn = list[decls.get(name)!] as Extract<Stmt, { k: "func" }>;
      hit = name;
      const value: Expr = { k: "func", name: null, params: fn.params, body: fn.body, ...(fn.generator === true ? { generator: true as const } : {}), ...(fn.async === true ? { async: true as const } : {}) };
      return { ...e, props: e.props.map((p, j) => (j === at ? { key: prop.key, computed: false, value } : p)) };
    };
    // Only a literal evaluated in a value-context branch or sequence: that is
    // where hermesc's placement of the hoisted closure differs observably in
    // the bytecode (a straight-line literal round-trips either way, so it
    // keeps the declaration form).
    const next = mapStmts([s], (x) => x, (e) => (hit === null && (e.k === "seq" || e.k === "cond" || e.k === "logical") ? mapExpr(e, intoSlot) : e));
    if (hit === null) continue;
    return { root: list, nodes: [list], data: { kind: "closure-slot", reg: hit, defIndex: decls.get(hit)!, useIndex: i, value: { k: "lit", text: "0" }, stmt: next[0]! }, at: atOf(s, ctx) };
  }
  return null;
}
