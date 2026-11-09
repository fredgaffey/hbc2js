// call-shape matcher — docs/LOWERING-CATALOGUE.md row R3,
// docs/specs/passes/04-call-shape.md §4.
//
// Site = one statement list `L` (`ctx.fnBody` reachable, innermost first).
// Unlike expr-rebuild/global-access (whose idiom lives at one fixed field of
// one statement), a `Reflect.apply`/`Reflect.construct`/helper call can sit
// anywhere in an expression tree, so `collectCandidates` walks every
// statement's own expression fields in pre-order (never descending into a
// nested `func` body or a nested `Stmt[]` — both are separate `stmtLists`
// sites) and `classifyNode` is total over any `call` node reachable that
// way: for a node whose callee is not one of the four recognised shapes it
// answers "not-a-call-shape-site" (match/​check both treat that the same as
// "keep scanning", never surfaced as a real abandonment); for a recognised
// shape it always resolves to either a rule + replacement or one of the
// named §7 refuse reasons.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, isHelperCall, isRegisterName } from "../ast.ts";
import { applyReplacement } from "./rewrite.ts";
import type { Match, PassContext } from "../types.ts";

export type CallShapeRule = "R3a" | "R3b" | "R3c" | "R3d" | "R3e";

export type RefuseReason = "dynamic-args" | "impure-callee" | "unproven-this" | "member-callee-with-undefined-this" | "explicit-new-target" | "duplicated-construct-callee" | "helper-arity" | "not-a-call-shape-site";

export interface CallShapeSite {
  readonly rule: CallShapeRule;
  readonly stmtIndex: number;
  /** The exact `call` node being replaced — identity, not shape, is how
   *  `rewrite`/`check` find it again inside `list[stmtIndex]`. */
  readonly target: Expr;
  readonly replacement: Expr;
  /** R3e only: `list[from..to]` (inclusive) is replaced by `stmts`. */
  readonly splice?: { readonly from: number; readonly to: number; readonly stmts: readonly Stmt[] };
}

export type CallShapeMatch = Match<readonly Stmt[], CallShapeSite>;

export type ClassifyResult = { readonly ok: true; readonly rule: CallShapeRule; readonly replacement: Expr } | { readonly ok: false; readonly reason: RefuseReason };

// ---------------------------------------------------------------------------
// §3 — the four recognised callee shapes.
// ---------------------------------------------------------------------------

/** `Reflect.apply`/`Reflect.construct` — `member(ident "Reflect", lit name,
 *  computed:false)` exactly (never by argument position). */
function isReflectMember(e: Expr, name: "apply" | "construct"): boolean {
  return e.k === "member" && !e.computed && e.obj.k === "ident" && e.obj.name === "Reflect" && e.prop.k === "lit" && e.prop.text === name;
}

type Variant = "apply" | "construct" | "helper-call" | "helper-apply";

function variantOf(e: Expr): Variant | null {
  if (e.k !== "call") return null;
  if (isReflectMember(e.callee, "apply")) return "apply";
  if (isReflectMember(e.callee, "construct")) return "construct";
  if (isHelperCall(e, "__hbc_b_functionPrototypeCall")) return "helper-call";
  if (isHelperCall(e, "__hbc_b_functionPrototypeApply")) return "helper-apply";
  return null;
}

// ---------------------------------------------------------------------------
// §4 common preconditions.
// ---------------------------------------------------------------------------

/** `e` is `{k:"array", elements}` with no `k:"seq"` element — the one shape
 *  R3a/R3b/R3c's argument-list operand may take (§4: a spread already
 *  materialised into an identifier, or an element that is itself a `seq`,
 *  means the arity is not statically enumerable at print time). `null` for
 *  anything else — the caller reports `dynamic-args`. */
function extractArgsArray(e: Expr): readonly Expr[] | null {
  if (e.k !== "array") return null;
  if (e.elements.some((el) => el.k === "seq")) return null;
  return e.elements;
}

/** `e` is `ident`, `lit`, or a `member` chain built only from `ident`/`lit`/
 *  further such `member`s (§4: "F is ident, or a member chain over
 *  ident/lit"). Anything containing a `call`, `new`, `assign` or `unary
 *  delete` — indeed anything but `member`/`ident`/`lit` at all — fails this,
 *  which is exactly the set of shapes able to reorder or duplicate an
 *  observable effect if evaluated an extra time. */
export function isSimpleCalleeChain(e: Expr): boolean {
  if (e.k === "ident" || e.k === "lit") return true;
  if (e.k !== "member") return false;
  return isSimpleCalleeChain(e.obj) && (!e.computed || isSimpleCalleeChain(e.prop));
}

/** Every `expr`-statement store `rX = value` reachable from `stmts`
 *  (including nested statement lists, excluding a nested `func`'s own
 *  frame) — copied from `global-access/match.ts`'s helper of the same
 *  purpose (D12a: a pass may not import a sibling pass's internals). */
function registerStoreValues(stmts: readonly Stmt[], reg: string): readonly Expr[] {
  const out: Expr[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) out.push(s.expr.value);
      switch (s.k) {
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "labeled":
        case "iife":
          visit(s.body);
          break;
        case "try":
          visit(s.block);
          visit(s.handler);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        default:
          break; // decl, break, continue, return, throw (no sub-list), func (separate frame)
      }
    }
  };
  visit(stmts);
  return out;
}

/** R3a's `T`: the literal `undefined`, or a register with exactly one write
 *  in `fnBody` whose value is the literal `undefined` (§4). Deliberately
 *  narrower than `global-access`'s `isProvenGlobal` (that one tolerates a
 *  *later* reuse of the register for scratch; this one cannot — a second
 *  write of *any* value, `undefined` or not, means the register no longer
 *  certifies "this call's `this` was always undefined" the way a single
 *  write does).
 *
 *  §4's literal text also asks for "no nested-closure read" on `t.name`
 *  (`identUses(fnBody, t.name).nested === 0`); that check is gone —
 *  `t.name` is a register (just proven above), and Hermes restarts register
 *  numbering per function, so a nested `func` body's own mention of the same
 *  number is provably that closure's own, unrelated local, never a read of
 *  *this* frame's `t`. A genuine capture would show up as a distinct,
 *  collision-free env-slot name (`_e<env>_<slot>`), never as the raw
 *  register — see `IdentUses.nested`'s doc in `../ast.ts`. This was the
 *  `21-iife-closures` gap recorded in `the status notes`/`AGENT-LOG.md`: every
 *  `this`-holding register in a closure-bearing function coincidentally
 *  collides with some nested closure's own numbering, so the literal-§4
 *  check refused `unproven-this` on every single site there. */
export function isProvenUndefinedThis(t: Expr, fnBody: readonly Stmt[]): boolean {
  if (t.k === "lit" && t.text === "undefined") return true;
  if (t.k !== "ident" || !isRegisterName(t.name)) return false;
  const writes = registerStoreValues(fnBody, t.name);
  return writes.length === 1 && writes[0]!.k === "lit" && writes[0]!.text === "undefined";
}

// ---------------------------------------------------------------------------
// §4 per-rule classification.
// ---------------------------------------------------------------------------

function classifyReflectApply(node: Expr & { readonly k: "call" }, fnBody: readonly Stmt[]): ClassifyResult {
  const [F, T, arr] = node.args;
  if (node.args.length !== 3 || F === undefined || T === undefined || arr === undefined) return { ok: false, reason: "dynamic-args" };
  const args = extractArgsArray(arr);
  if (args === null) return { ok: false, reason: "dynamic-args" };

  if (F.k === "member") {
    if (!isSimpleCalleeChain(F)) return { ok: false, reason: "impure-callee" };
    const O = F.obj;
    const sameIdent = O.k === "ident" && T.k === "ident" && T.name === O.name;
    if (sameIdent) return { ok: true, rule: "R3b", replacement: { k: "call", callee: F, args } };
    if (isProvenUndefinedThis(T, fnBody)) return { ok: false, reason: "member-callee-with-undefined-this" };
    return { ok: false, reason: "unproven-this" };
  }

  if (!isSimpleCalleeChain(F)) return { ok: false, reason: "impure-callee" };
  if (!isProvenUndefinedThis(T, fnBody)) return { ok: false, reason: "unproven-this" };
  return { ok: true, rule: "R3a", replacement: { k: "call", callee: F, args } };
}

function classifyReflectConstruct(node: Expr & { readonly k: "call" }): ClassifyResult {
  const C = node.args[0];
  const arr = node.args[1];
  const NT = node.args[2];
  if (node.args.length < 2 || node.args.length > 3 || C === undefined || arr === undefined) return { ok: false, reason: "dynamic-args" };
  const args = extractArgsArray(arr);
  if (args === null) return { ok: false, reason: "dynamic-args" };
  if (!isSimpleCalleeChain(C)) return { ok: false, reason: "impure-callee" };
  if (NT !== undefined) {
    if (JSON.stringify(NT) !== JSON.stringify(C)) return { ok: false, reason: "explicit-new-target" };
    // Same syntactic new-target as the callee: `new C(args)` evaluates `C`
    // ONCE, but `Reflect.construct(C, args, C)` evaluates it TWICE (once as
    // target, once as new-target). Free only when `C` is an identifier/
    // register — re-reading an identifier is side-effect-free. A member
    // callee (`a.b`) is NOT free to re-evaluate: a getter or Proxy trap on
    // `b` would fire once instead of twice, an observable behaviour change
    // the recompute-and-compare `check` cannot see (it re-derives the same
    // verdict from the same rule, so it agrees with a bug in the rule
    // itself). See a removed report H1.
    if (C.k !== "ident") return { ok: false, reason: "duplicated-construct-callee" };
  }
  return { ok: true, rule: "R3c", replacement: { k: "new", callee: C, args } };
}

function classifyHelperCall(node: Expr & { readonly k: "call" }): ClassifyResult {
  if (node.args.length < 2) return { ok: false, reason: "helper-arity" };
  const [F, T, ...rest] = node.args;
  if (!isSimpleCalleeChain(F!)) return { ok: false, reason: "impure-callee" };
  const callee: Expr = { k: "member", obj: F!, prop: { k: "lit", text: "call" }, computed: false };
  return { ok: true, rule: "R3d", replacement: { k: "call", callee, args: [T!, ...rest] } };
}

function classifyHelperApply(node: Expr & { readonly k: "call" }): ClassifyResult {
  if (node.args.length !== 3) return { ok: false, reason: "helper-arity" };
  const [F, T, arr] = node.args;
  if (!isSimpleCalleeChain(F!)) return { ok: false, reason: "impure-callee" };
  const callee: Expr = { k: "member", obj: F!, prop: { k: "lit", text: "apply" }, computed: false };
  return { ok: true, rule: "R3d", replacement: { k: "call", callee, args: [T!, arr!] } };
}

/** Total over any `Expr`: recognises the four callee shapes and, for a
 *  recognised one, fully re-derives the verdict from `node`/`fnBody` alone —
 *  no captured `match` data is ever trusted (`check.ts` calls this again on
 *  `before`, exactly as `match` does). */
export function classifyNode(node: Expr, fnBody: readonly Stmt[]): ClassifyResult {
  const variant = variantOf(node);
  if (variant === null) return { ok: false, reason: "not-a-call-shape-site" };
  const call = node as Expr & { readonly k: "call" };
  switch (variant) {
    case "apply":
      return classifyReflectApply(call, fnBody);
    case "construct":
      return classifyReflectConstruct(call);
    case "helper-call":
      return classifyHelperCall(call);
    case "helper-apply":
      return classifyHelperApply(call);
  }
}

// ---------------------------------------------------------------------------
// §4 site enumeration — pre-order over one statement list, never crossing
// into a nested `Stmt[]` (a separate `stmtLists` site) or a nested `func`
// body (a separate frame).
// ---------------------------------------------------------------------------

/** The `Expr` fields directly on `s` (mirrors `global-access`/`expr-rebuild`'s
 *  own `topLevelExprFields`/`topLevelExprOf`). */
function exprFieldsOf(s: Stmt): readonly Expr[] {
  switch (s.k) {
    case "expr":
      return [s.expr];
    case "init":
      return [s.value];
    case "if":
      return [s.test];
    case "while":
      return s.test !== undefined ? [s.test] : [];
    case "do-while":
      return [s.test];
    case "for":
      return [s.init, s.test, s.update].filter((x): x is Expr => x !== null);
    case "return":
      return s.arg !== null ? [s.arg] : [];
    case "throw":
      return [s.arg];
    case "switch":
      return [s.disc];
    default:
      return []; // decl, break, continue, labeled, try, switch-body, func, iife: no own field
  }
}

export interface CandidateSite {
  readonly stmtIndex: number;
  readonly node: Expr;
}

function collectFromExpr(e: Expr, stmtIndex: number, out: CandidateSite[]): void {
  if (e.k === "call") out.push({ stmtIndex, node: e });
  switch (e.k) {
    case "member":
      collectFromExpr(e.obj, stmtIndex, out);
      if (e.computed) collectFromExpr(e.prop, stmtIndex, out);
      return;
    case "call":
    case "new":
      collectFromExpr(e.callee, stmtIndex, out);
      e.args.forEach((a) => collectFromExpr(a, stmtIndex, out));
      return;
    case "bin":
    case "logical":
      collectFromExpr(e.left, stmtIndex, out);
      collectFromExpr(e.right, stmtIndex, out);
      return;
    case "unary":
      collectFromExpr(e.arg, stmtIndex, out);
      return;
    case "assign":
      collectFromExpr(e.target, stmtIndex, out);
      collectFromExpr(e.value, stmtIndex, out);
      return;
    case "cond":
      collectFromExpr(e.test, stmtIndex, out);
      collectFromExpr(e.then, stmtIndex, out);
      collectFromExpr(e.else, stmtIndex, out);
      return;
    case "array":
      e.elements.forEach((x) => collectFromExpr(x, stmtIndex, out));
      return;
    case "object":
      e.props.forEach((p) => collectFromExpr("k" in p ? p.arg : p.value, stmtIndex, out));
      return;
    case "spread": // F17
      collectFromExpr(e.arg, stmtIndex, out);
      return;
    case "seq":
      e.exprs.forEach((x) => collectFromExpr(x, stmtIndex, out));
      return;
    default:
      return; // ident, lit, this, argumentsObject, func (separate frame)
  }
}

/** Every `call` node reachable from `list`, in pre-order, tagged with its
 *  owning statement's index — a `call` that is not one of the four
 *  recognised shapes is still collected (so a nested candidate inside a
 *  plain call's arguments is still found), `classifyNode` just answers
 *  `not-a-call-shape-site` for it. */
export function collectCandidates(list: readonly Stmt[]): readonly CandidateSite[] {
  const out: CandidateSite[] = [];
  list.forEach((s, stmtIndex) => {
    for (const field of exprFieldsOf(s)) collectFromExpr(field, stmtIndex, out);
  });
  return out;
}

export function match(list: readonly Stmt[], ctx: PassContext): CallShapeMatch | null {
  const fnBody = ctx.fnBody ?? list;
  for (const c of collectCandidates(list)) {
    const result = classifyNode(c.node, fnBody);
    if (result.ok) {
      return {
        root: list,
        nodes: [list],
        data: { rule: result.rule, stmtIndex: c.stmtIndex, target: c.node, replacement: result.replacement },
        at: { functionIndex: ctx.functionIndex, offset: c.stmtIndex },
      };
    }
  }
  const r3e = matchCondArg(list, fnBody);
  if (r3e !== null) return { root: list, nodes: [list], data: r3e, at: { functionIndex: ctx.functionIndex, offset: r3e.stmtIndex } };
  return null;
}

// ---------------------------------------------------------------------------
// R3e (spec 04 section 9) -- the callee read separated from its call by the
// arguments' own control flow: `F = R.P; <args>; Reflect.apply(F, R, [A...])`
// -> `R.P((<args as expressions>, A1), A2, ...)`.
// ---------------------------------------------------------------------------

/** The `Reflect.apply` call `s` evaluates FIRST (statement value, an
 *  assignment's value, or the object of a member read), else null. */
function leadingCall(s: Stmt, assigned: string[] = []): (Expr & { readonly k: "call" }) | null {
  let e: Expr | null = s.k === "expr" ? s.expr : s.k === "init" ? s.value : s.k === "return" ? s.arg : null;
  while (e !== null) {
    if (e.k === "call") return isReflectMember(e.callee, "apply") ? e : null;
    if (e.k === "assign" && e.target.k === "ident") {
      assigned.push(e.target.name);
      e = e.value;
    }
    else if (e.k === "member") e = e.obj;
    else return null;
  }
  return null;
}

function isBreakTo(s: Stmt | undefined, label: string): boolean {
  return s !== undefined && s.k === "break" && s.label === label;
}

/** `stmts` (the tail of a block labelled `label`, or one top-level statement
 *  when `label` is null) as expressions evaluated in the same order with the
 *  same effects: `if (C) break L; T...` is `C || (T...)`, a trailing
 *  `break L` ends the block, a nested labelled block is flattened the same
 *  way. Anything else (declarations, loops, other jumps) is null. */
function toExprs(stmts: readonly Stmt[], label: string | null): Expr[] | null {
  const out: Expr[] = [];
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    if (s.k === "expr") out.push(s.expr);
    else if (label !== null && isBreakTo(s, label)) return i === stmts.length - 1 ? out : null;
    else if (label !== null && s.k === "if" && s.then.length >= 1 && isBreakTo(s.then[s.then.length - 1], label) && s.else.length === 0) {
      const rest = toExprs(stmts.slice(i + 1), label);
      if (rest === null) return null;
      if (s.then.length > 1) {
        // `if (C) { T; break L; } E; break L;` is `C ? (T) : (E)` (`C && (T)` with no E).
        const then = toExprs(s.then, label);
        if (then === null || then.length === 0) return null;
        const seqOf = (es: readonly Expr[]): Expr => (es.length === 1 ? es[0]! : { k: "seq", exprs: es });
        out.push(rest.length === 0 ? { k: "logical", op: "&&", left: s.test, right: seqOf(then) } : { k: "cond", test: s.test, then: seqOf(then), else: seqOf(rest) });
        return out;
      }
      // `if (!C) break L; T` is `C && (T)`; `if (C) break L; T` is `C || (T)`.
      const negated = s.test.k === "unary" && s.test.op === "!";
      const test = negated && s.test.k === "unary" ? s.test.arg : s.test;
      out.push(rest.length === 0 ? s.test : { k: "logical", op: negated ? "&&" : "||", left: test, right: rest.length === 1 ? rest[0]! : { k: "seq", exprs: rest } });
      return out;
    } else if (s.k === "labeled") {
      const inner = toExprs(s.body, s.label);
      if (inner === null) return null;
      out.push(...inner);
    } else return null;
  }
  return out;
}

/** Any `break`/`continue` naming `label` inside `stmts`. */
function mentionsLabel(stmts: readonly Stmt[], label: string): boolean {
  return JSON.stringify(stmts).includes(`"label":${JSON.stringify(label)}`);
}

function isMemberOf(e: Expr, r: string): e is Expr & { readonly k: "member" } {
  return e.k === "member" && e.obj.k === "ident" && e.obj.name === r && isSimpleCalleeChain(e);
}

/** `F = R.P` exactly. */
function readOf(s: Stmt, f: string, r: string): (Expr & { readonly k: "member" }) | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident" || s.expr.target.name !== f) return null;
  return isMemberOf(s.expr.value, r) ? s.expr.value : null;
}

export function matchCondArg(list: readonly Stmt[], fnBody: readonly Stmt[]): CallShapeSite | null {
  for (let j = 1; j < list.length; j++) {
    const assigned: string[] = [];
    const call = leadingCall(list[j]!, assigned);
    if (call === null || call.args.length !== 3) continue;
    const [F, R, arr] = call.args;
    if (F!.k !== "ident" || R!.k !== "ident" || !isRegisterName(F!.name) || !isRegisterName(R!.name) || F!.name === R!.name) continue;
    const args = extractArgsArray(arr!);
    if (args === null || args.length === 0) continue;
    const f = F!.name;
    const r = R!.name;
    // The value `F = R.P` stores must die at this call: F read once in it,
    // and either F used nowhere else or this statement overwrites F.
    const uses = identUses(fnBody, f);
    if (identUses([list[j]!], f).reads !== 1) continue;
    if (!(uses.reads === 1 && uses.writes === 1) && !assigned.includes(f)) continue;
    // The statement writing F, scanning back from the call.
    let k = j - 1;
    while (k >= 0 && identUses([list[k]!], f).writes === 0) k--;
    if (k < 0) continue;
    const def = list[k]!;
    let read: (Expr & { readonly k: "member" }) | null = readOf(def, f, r);
    let hoisted: readonly Stmt[] = [];
    const seq: Expr[] = [];
    if (read === null) {
      if (def.k !== "labeled") continue;
      const i = def.body.findIndex((s) => readOf(s, f, r) !== null);
      if (i < 0) continue;
      read = readOf(def.body[i]!, f, r);
      hoisted = def.body.slice(0, i);
      // Hoisting the prefix out of the block must not move a block-scoped
      // declaration, nor a jump that would skip the read.
      if (mentionsLabel(hoisted, def.label) || hoisted.some((h) => h.k === "decl" || h.k === "init" || h.k === "func" || h.k === "classdecl")) continue;
      const tail = toExprs(def.body.slice(i + 1), def.label);
      if (tail === null) continue;
      seq.push(...tail);
    }
    const decls: Stmt[] = [];
    let ok = true;
    for (let m = k + 1; m < j && ok; m++) {
      const s = list[m]!;
      if (s.k === "init" && s.kind !== "const") {
        decls.push({ k: "decl", kind: s.kind, names: [s.name] });
        seq.push({ k: "assign", target: { k: "ident", name: s.name }, value: s.value });
        continue;
      }
      const e = toExprs([s], null);
      if (e === null) ok = false;
      else seq.push(...e);
    }
    if (!ok || read === null) continue;
    // `this` must be the value R held when P was read: no write to R between.
    if (seq.length > 0) {
      const mid: Stmt[] = [{ k: "expr", expr: { k: "seq", exprs: seq } }];
      const fu = identUses(mid, f);
      if (identUses(mid, r).writes !== 0 || fu.reads !== 0 || fu.writes !== 0) continue;
    }
    const callArgs = seq.length === 0 ? args : [{ k: "seq", exprs: [...seq, args[0]!] } as Expr, ...args.slice(1)];
    const replacement: Expr = { k: "call", callee: read, args: callArgs };
    const newStmt = applyReplacement(list[j]!, call, replacement);
    return { rule: "R3e", stmtIndex: j, target: call, replacement, splice: { from: k, to: j, stmts: [...hoisted, ...decls, newStmt] } };
  }
  return null;
}
