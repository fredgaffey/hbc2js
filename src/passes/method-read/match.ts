// method-read matcher — docs/specs/05-emit*.md section 7.4 (evaluation order of
// a method call whose read is separated from its call by observable work).
//
// The emitter leaves `rF = rO.m; <work>; Reflect.apply(rF, rO, [A...])` with
// the call tagged `methodRead` when an observable instruction sits between the
// read and the call (it proved `rF` dead after the call, and neither `rF` nor
// `rO` written in between). Registered after `object-literal`/`array-literal`/
// `private-fields`, so `<work>` is already folded into literals, this rung
// re-fuses `rO.m((<work>), A1, A2...)` -- the evaluation order is still read,
// work, arguments -- then folds trailing `rX = E` work items into the slot
// that reads `rX` (expr-rebuild's R1a on the sequence): an item moves only
// past earlier slots that are literals or register reads E does not write.
import { identUses, isRegisterName } from "../ast.ts";
import type { Expr, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

type Call = Extract<Expr, { k: "call" }>;

export interface MethodReadSite {
  /** `list[from..to]` (inclusive) becomes `stmts`. */
  readonly from: number;
  readonly to: number;
  readonly stmts: readonly Stmt[];
}
export type MethodReadMatch = Match<readonly Stmt[], MethodReadSite>;

/** The call a statement evaluates first and as its whole work, plus the
 *  register the statement assigns after it (if any). */
function topCall(s: Stmt): { call: Call; assigned: string | null } | null {
  let e: Expr | null = null;
  let assigned: string | null = null;
  if (s.k === "expr") {
    if (s.expr.k === "assign" && s.expr.target.k === "ident") {
      e = s.expr.value;
      assigned = s.expr.target.name;
    } else e = s.expr;
  } else if (s.k === "return") e = s.arg;
  else if (s.k === "init") e = s.value;
  return e !== null && e.k === "call" ? { call: e, assigned } : null;
}

function withValue(s: Stmt, v: Expr): Stmt {
  if (s.k === "expr") return s.expr.k === "assign" ? { ...s, expr: { ...s.expr, value: v } } : { ...s, expr: v };
  if (s.k === "return") return { ...s, arg: v };
  if (s.k === "init") return { ...s, value: v };
  return s;
}

const asStmts = (es: readonly Expr[]): Stmt[] => es.map((e) => ({ k: "expr", expr: e }) as Stmt);
/** `reg` holds no value read after statement `j`: the statement overwrites it,
 *  the function reads it nowhere outside `list[k+1..j]`, or it is overwritten later in `list`
 *  before any read (straight-line statements only). */
function deadAfter(list: readonly Stmt[], fnBody: readonly Stmt[], k: number, j: number, reg: string, assigned: string | null): boolean {
  if (assigned === reg) return true;
  const fu = identUses(fnBody, reg);
  if (fu.nested !== 0) return false;
  // every read in the function is inside the statements being fused
  if (fu.reads === identUses(list.slice(k + 1, j + 1), reg).reads) return true;
  for (let k = j + 1; k < list.length; k++) {
    const s = list[k]!;
    if (s.k === "comment" || s.k === "decl") continue;
    if (s.k === "return") return identUses([s], reg).reads === 0;
    if (s.k !== "expr" && s.k !== "init") return false;
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) return identUses([{ k: "expr", expr: s.expr.value }], reg).reads === 0;
    const u = identUses([s], reg);
    if (u.reads + u.writes + u.nested > 0) return false;
  }
  // Falling off the end of the function body itself: nothing reads it again.
  return list === fnBody;
}

/** Where evaluating `e` first meets `reg`: `"found"` when every evaluation
 *  before that read is a literal or a non-global binding read (no code runs,
 *  nothing can throw), `"pure"` when `e` is wholly such reads and never reads
 *  `reg`, else `"impure"`. `names` collects the bindings read on the way. */
function leadingRead(e: Expr, reg: string, names: string[]): "found" | "pure" | "impure" {
  switch (e.k) {
    case "lit":
      return "pure";
    case "ident":
      if (e.name === reg) return "found";
      if (e.global === true) return "impure";
      names.push(e.name);
      return "pure";
    case "member": {
      const r = leadingRead(e.obj, reg, names);
      if (r !== "pure" || !e.computed) return r === "found" ? "found" : "impure";
      // the property get itself may run a getter
      return leadingRead(e.prop, reg, names) === "found" ? "found" : "impure";
    }
    case "call": {
      // callee, then the arguments in order, then the call itself
      const r = leadingRead(e.callee, reg, names);
      if (r !== "pure") return r;
      for (const a of e.args) {
        const ra = leadingRead(a, reg, names);
        if (ra !== "pure") return ra;
      }
      return "impure";
    }
    case "array":
    case "object": {
      const parts = e.k === "array" ? e.elements : e.props.map((p) => ("k" in p || p.computed || p.key === "__proto__" ? null : p.value));
      for (const v of parts) {
        if (v === null || v === undefined) return "impure";
        const r = leadingRead(v, reg, names);
        if (r !== "pure") return r;
      }
      return "pure";
    }
    default:
      return "impure";
  }
}

/** `e` with the one read `leadingRead` found replaced by `v`. */
function replaceLeading(e: Expr, reg: string, v: Expr): Expr {
  switch (e.k) {
    case "ident":
      return e.name === reg ? v : e;
    case "member":
      return leadingRead(e.obj, reg, []) === "found" ? { ...e, obj: replaceLeading(e.obj, reg, v) } : { ...e, prop: replaceLeading(e.prop, reg, v) };
    case "call": {
      if (leadingRead(e.callee, reg, []) === "found") return { ...e, callee: replaceLeading(e.callee, reg, v) };
      const i = e.args.findIndex((x) => leadingRead(x, reg, []) === "found");
      return { ...e, args: e.args.map((x, j) => (j === i ? replaceLeading(x, reg, v) : x)) };
    }
    case "array": {
      const i = e.elements.findIndex((x) => leadingRead(x, reg, []) === "found");
      return { ...e, elements: e.elements.map((x, j) => (j === i ? replaceLeading(x, reg, v) : x)) };
    }
    case "object": {
      const i = e.props.findIndex((p) => !("k" in p) && leadingRead(p.value, reg, []) === "found");
      return { ...e, props: e.props.map((p, j) => (j === i && !("k" in p) ? { ...p, value: replaceLeading(p.value, reg, v) } : p)) };
    }
    default:
      return e;
  }
}

/** Folds trailing `rX = E` items of `seq` (mutated) into the arguments: E
 *  replaces the one read of rX when everything evaluated before that read is
 *  a literal or a binding read E does not write, so E's effects keep their
 *  place in the effect sequence. */
export function foldSeqIntoArgs(seq: Expr[], args: readonly Expr[], dead: (reg: string) => boolean): Expr[] {
  const out = [...args];
  for (;;) {
    const last = seq[seq.length - 1];
    if (last === undefined || last.k !== "assign" || last.target.k !== "ident" || !isRegisterName(last.target.name)) break;
    const reg = last.target.name;
    const value = last.value;
    // Reads of `reg` earlier in the sequence see older values; only the
    // arguments' reads matter.
    const inArgs = identUses(asStmts(out), reg);
    if (inArgs.reads !== 1 || inArgs.nested !== 0 || inArgs.writes !== 0) break;
    const names: string[] = [];
    let q = -1;
    for (let i = 0; i < out.length && q < 0; i++) {
      const r = leadingRead(out[i]!, reg, names);
      if (r === "found") q = i;
      else if (r === "impure") break;
    }
    if (q < 0) break;
    const valueStmts = asStmts([value]);
    if (names.some((n) => identUses(valueStmts, n).writes !== 0)) break;
    if (!dead(reg)) {
      // Still live after the call: `(…, rX = E, rX)` is `(…, rX = E)` -- the
      // assignment's own value -- when the slot is exactly the first one.
      if (q !== 0 || out[0]!.k !== "ident") break;
      out[0] = last;
      seq.pop();
      break;
    }
    out[q] = replaceLeading(out[q]!, reg, value);
    seq.pop();
  }
  return out;
}

/** A call or construct anywhere in `e` (not inside a nested function). */
function hasCall(e: Expr): boolean {
  if (e.k === "call" || e.k === "new") return true;
  if (e.k === "func" || e.k === "class") return false;
  for (const v of Object.values(e)) {
    if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === "object" && (("k" in x && hasCall(x as Expr)) || (!("k" in x) && "value" in x && hasCall((x as { value: Expr }).value)))) return true;
    } else if (v !== null && typeof v === "object" && "k" in v && hasCall(v as Expr)) return true;
  }
  return false;
}

export function matchSite(list: readonly Stmt[], fnBody: readonly Stmt[]): MethodReadSite | null {
  for (let j = 1; j < list.length; j++) {
    const top = topCall(list[j]!);
    if (top === null || top.call.methodRead !== true || top.call.args.length !== 3) continue;
    const [F, R, arr] = top.call.args;
    if (F!.k !== "ident" || R!.k !== "ident" || !isRegisterName(F!.name) || !isRegisterName(R!.name) || F!.name === R!.name) continue;
    if (arr!.k !== "array" || arr!.elements.some((el) => el.k === "seq" || el.k === "spread")) continue;
    const f = F!.name;
    const r = R!.name;
    if (identUses([list[j]!], f).reads !== 1) continue;
    let k = j - 1;
    while (k >= 0 && identUses([list[k]!], f).writes === 0) k--;
    if (k < 0) continue;
    const def = list[k]!;
    let read: Expr;
    if (def.k === "expr" && def.expr.k === "assign" && def.expr.target.k === "ident" && def.expr.target.name === f) read = def.expr.value;
    else if (def.k === "init" && def.name === f && def.kind !== "const") read = def.value;
    else continue;
    if (read.k !== "member" || read.obj.k !== "ident" || read.obj.name !== r) continue;
    const seq: Expr[] = [];
    const decls: Stmt[] = [];
    // `let f = R.P` declared F: keep the declaration when F is used elsewhere.
    if (def.k === "init") {
      const u = identUses(fnBody, f);
      if (u.reads + u.writes + u.nested > 2) decls.push({ k: "decl", kind: def.kind, names: [f] });
    }
    let ok = true;
    for (let m = k + 1; m < j && ok; m++) {
      const s = list[m]!;
      if (s.k === "expr") seq.push(s.expr);
      else if (s.k === "init" && s.kind !== "const") {
        decls.push({ k: "decl", kind: s.kind, names: [s.name] });
        seq.push({ k: "assign", target: { k: "ident", name: s.name }, value: s.value });
      } else if (s.k !== "comment") ok = false;
    }
    if (!ok) continue;
    // `this` must be the value R held at the read, and F untouched in between.
    const mid = asStmts(seq);
    const fu = identUses(mid, f);
    if (identUses(mid, r).writes !== 0 || fu.reads !== 0 || fu.writes !== 0) continue;
    const args = foldSeqIntoArgs(seq, arr!.elements, (reg) => deadAfter(list, fnBody, k, j, reg, top.assigned));
    if (seq.length > 0 && args.length === 0) continue;
    // Work that still holds a call stays in statement form, unfused: a nested
    // call site (an inline require, a child element) is evidence later rungs
    // read as statements, and the unfused form is already in source order.
    if (seq.some(hasCall)) continue;
    const callArgs = seq.length === 0 ? args : [{ k: "seq", exprs: [...seq, args[0]!] } as Expr, ...args.slice(1)];
    const fused: Expr = { k: "call", callee: read, args: callArgs };
    return { from: k, to: j, stmts: [...decls, withValue(list[j]!, fused)] };
  }
  return null;
}

export function match(list: readonly Stmt[], ctx: PassContext): MethodReadMatch | null {
  const site = matchSite(list, ctx.fnBody ?? list);
  return site === null ? null : { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: site.to } };
}
