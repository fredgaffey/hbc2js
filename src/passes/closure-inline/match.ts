// closure-inline matcher (docs/specs/passes/32-closure-inline.md section 3).
// One site: the whole function body. Finds the first top-level hoisted
// `function _fnN` declaration whose value is read exactly once, outside every
// loop, and returns its index; `rewrite` moves the declaration to that read.
import { identUses, isRegisterName, stmtLists, walk } from "../ast.ts";
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export interface ClosureInlineSite {
  /** Index of the `func` statement in `ctx.fnBody`. */
  readonly index: number;
  readonly name: string;
}

const LOOPS = new Set(["while", "do-while", "for", "for-in", "for-of"]);

/** Every identifier mentioned anywhere in `s`, nested functions included. */
function mentioned(s: Stmt): Set<string> {
  const out = new Set<string>();
  walk([s], { expr: (e) => { if (e.k === "ident") out.add(e.name); } });
  return out;
}

/** Names that some NESTED block of `body` (not `body` itself, not a nested
 *  function) declares, plus every `catch` parameter and loop binding -- a
 *  binding that could shadow, at the read site, a name the closure uses. */
function nestedBindings(body: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  for (const list of stmtLists(body)) {
    for (const s of list) {
      if (list !== body) {
        if (s.k === "decl") for (const n of s.names) out.add(n);
        else if (s.k === "init" || s.k === "func" || s.k === "classdecl") out.add(s.name);
      }
      if (s.k === "try" && s.param !== null) out.add(s.param);
      if ((s.k === "for-in" || s.k === "for-of") && s.left.k === "ident") out.add(s.left.name);
    }
  }
  return out;
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function classify(body: readonly Stmt[], index: number): Verdict {
  const f = body[index];
  if (f === undefined || f.k !== "func") return { ok: false, reason: "not-a-declaration" };
  const self = identUses([f], f.name);
  if (self.reads > 0 || self.nested > 0 || mentionsInside(f)) return { ok: false, reason: "self-reference" };
  const rest = body.filter((_, i) => i !== index);
  const u = identUses(rest, f.name);
  if (u.writes > 0) return { ok: false, reason: "written" };
  if (u.nested > 0) return { ok: false, reason: "nested-use" };
  if (u.reads !== 1) return { ok: false, reason: u.reads === 0 ? "unused" : "multi-use" };
  for (const list of stmtLists(rest)) {
    for (const s of list) {
      if (LOOPS.has(s.k) && identUses([s], f.name).reads > 0) return { ok: false, reason: "in-loop" };
    }
  }
  if (isDeclarationStore(rest, f.name)) return { ok: false, reason: "declaration-store" };
  const shadow = nestedBindings(rest);
  for (const n of mentioned(f)) if (n !== f.name && shadow.has(n)) return { ok: false, reason: "shadowed" };
  return { ok: true };
}

/** Is the one read exactly the stored value of `x = name` / `let x = name`
 *  with `x` NOT a register (a member, an env slot, a named binding)? That is
 *  how a source function DECLARATION surfaces (`r1.m = m`, `_e14_3 = _fn5`):
 *  Hermes created its closure at entry, where the store already sits, so
 *  inlining would change no bytecode and would only cost the declaration
 *  form. A read copied into a register, or nested in a larger expression (an
 *  argument, a descriptor literal), is a function EXPRESSION's position. */
function isDeclarationStore(stmts: readonly Stmt[], name: string): boolean {
  let hit = false;
  for (const list of stmtLists(stmts)) {
    for (const s of list) {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "ident" && s.expr.value.name === name) {
        if (!(s.expr.target.k === "ident" && isRegisterName(s.expr.target.name))) hit = true;
      } else if (s.k === "init" && s.value.k === "ident" && s.value.name === name && !isRegisterName(s.name)) hit = true;
    }
  }
  return hit;
}

/** Does `f`'s own body or parameter list mention its name? */
function mentionsInside(f: Stmt & { readonly k: "func" }): boolean {
  let hit = false;
  walk(f.body, { expr: (e) => { if (e.k === "ident" && e.name === f.name) hit = true; } });
  for (const p of f.params) if (p.name === f.name) hit = true;
  return hit;
}

export function findSite(body: readonly Stmt[]): ClosureInlineSite | null {
  for (let i = 0; i < body.length; i++) {
    const s = body[i]!;
    if (s.k === "func" && classify(body, i).ok) return { index: i, name: s.name };
  }
  return null;
}

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], ClosureInlineSite> | null {
  if (list !== ctx.fnBody) return null;
  const site = findSite(list);
  if (site === null) return null;
  return { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
