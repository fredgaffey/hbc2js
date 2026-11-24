// Linear-time replacements for the two whole-list obligations a rung's
// `check` states about a rewrite that replaces ONE top-level statement of a
// function body: "the result parses" (`parses`) and "no new free name"
// (`freeNames(after) ⊆ freeNames(before)`). Spec 29 section 12, "Scoped
// rewrite checks", has the argument that each answers exactly what the
// whole-list form answers; this file is the mechanism.
//
// Everything is cached by object identity. Statements and statement lists are
// immutable (`readonly` throughout the AST), so a fact computed for one
// object stays true of it. A rewrite's `after` list shares every statement but
// one with `before`, and the next match's `before` is that same `after` array
// (`applyAstPasses` splices a top-level rewrite as the list itself), so the
// per-list index is moved from `before` to `after` by a one-statement delta.

import type { Stmt } from "../emit/ast.ts";
import { freeNames, parses, walk } from "./ast.ts";

/** Per-statement facts, each the statement's own contribution to the
 *  corresponding whole-list computation. */
interface StmtFacts {
  /** Names `freeNames`' visitor records as used inside this statement, in its
   *  walk order. */
  readonly used: ReadonlySet<string>;
  /** Names `freeNames`' visitor records as bound inside this statement. */
  readonly bound: ReadonlySet<string>;
  /** Names this statement declares lexically in the enclosing function
   *  body's top-level scope (`let`/`const`/`class` in statement position). */
  readonly lex: readonly string[];
  /** A superset of the names this statement adds to the enclosing function's
   *  VarDeclaredNames: every `var` at any block depth (never inside a nested
   *  function), the name of a function declaration at any block depth (the
   *  top-level one is var-scoped; a nested one, Annex B, is included only to
   *  stay on the safe side). */
  readonly vars: ReadonlySet<string>;
  /** A `raw` statement anywhere at block depth: verbatim text, so nothing
   *  above can be said about it. */
  readonly opaque: boolean;
}

const factsCache = new WeakMap<Stmt, StmtFacts>();

function factsOf(s: Stmt): StmtFacts {
  const hit = factsCache.get(s);
  if (hit !== undefined) return hit;
  // Exactly `freeNames`' visitor, applied to this one statement.
  const used = new Set<string>();
  const bound = new Set<string>();
  walk([s], {
    expr: (e) => {
      if (e.k === "ident") used.add(e.name);
      else if (e.k === "func") {
        if (e.name !== null) bound.add(e.name);
        for (const param of e.params) bound.add(param.name);
      }
    },
    stmt: (t) => {
      if (t.k === "decl") for (const n of t.names) bound.add(n);
      else if (t.k === "init") bound.add(t.name);
      else if (t.k === "try") { if (t.param !== null) bound.add(t.param); }
      else if ((t.k === "for-in" || t.k === "for-of") && t.left.k === "ident") bound.add(t.left.name);
      else if (t.k === "func") {
        bound.add(t.name);
        for (const param of t.params) bound.add(param.name);
      }
    },
  });
  const lex: string[] = [];
  if ((s.k === "decl" || s.k === "init") && s.kind !== "var") lex.push(...(s.k === "decl" ? s.names : [s.name]));
  else if (s.k === "classdecl") lex.push(s.name);
  const vars = new Set<string>();
  let opaque = false;
  // Block-depth statements only: expressions hold no declarations except in
  // function/class bodies, which are scopes of their own.
  const blocks = (list: readonly Stmt[]): void => {
    for (const t of list) {
      switch (t.k) {
        case "decl":
          if (t.kind === "var") for (const n of t.names) vars.add(n);
          break;
        case "init":
          if (t.kind === "var") vars.add(t.name);
          break;
        case "func":
          vars.add(t.name);
          break;
        case "if":
          blocks(t.then);
          blocks(t.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "labeled":
          blocks(t.body);
          break;
        case "for-in":
        case "for-of":
          if (t.decl === "var") walk([{ k: "expr", expr: t.left }], { expr: (e) => { if (e.k === "ident") vars.add(e.name); } });
          blocks(t.body);
          break;
        case "try":
          blocks(t.block);
          blocks(t.handler);
          if (t.finalizer !== undefined) blocks(t.finalizer);
          break;
        case "switch":
          for (const c of t.cases) blocks(c.body);
          break;
        case "raw":
          opaque = true;
          break;
        default:
          break; // expr, return, throw, break, continue, classdecl, directive, iife, comment
      }
    }
  };
  blocks([s]);
  const f: StmtFacts = { used, bound, lex, vars, opaque };
  factsCache.set(s, f);
  return f;
}

/** The directive-prologue candidates: the maximal leading run of statements
 *  that print as a directive, a string-literal expression statement or a
 *  comment. Every scoped parse is wrapped with exactly these in front, so the
 *  strictness of the wrapper is the strictness of the whole list. */
function prologueOf(list: readonly Stmt[]): readonly Stmt[] {
  let n = 0;
  while (n < list.length) {
    const s = list[n]!;
    if (s.k === "directive" || s.k === "comment" || (s.k === "expr" && s.expr.k === "lit")) n++;
    else break;
  }
  return list.slice(0, n);
}

const standaloneCache = new WeakMap<Stmt, Map<readonly Stmt[] | string, boolean>>();
const NO_PROLOGUE = "";

/** `parses([...prologue, s])`, cached per statement and prologue. */
function standalone(s: Stmt, prologue: readonly Stmt[], key: readonly Stmt[] | string): boolean {
  let m = standaloneCache.get(s);
  if (m === undefined) standaloneCache.set(s, (m = new Map()));
  let v = m.get(key);
  if (v === undefined) m.set(key, (v = parses([...prologue, s])));
  return v;
}

const bump = (m: Map<string, number>, k: string, d: number): void => {
  const v = (m.get(k) ?? 0) + d;
  if (v === 0) m.delete(k);
  else m.set(k, v);
};

/** Per-list aggregate: per-name statement counts and the counts that decide
 *  the scoped parse. */
class ListIndex {
  readonly used = new Map<string, number>();
  readonly bound = new Map<string, number>();
  readonly lex = new Map<string, number>();
  readonly vars = new Map<string, number>();
  /** Names with a lexical/lexical or lexical/var collision. */
  conflicts = 0;
  opaque = 0;
  /** Statements that do not parse on their own inside the wrapper. */
  bad = 0;
  readonly prologue: readonly Stmt[];
  readonly prologueKey: readonly Stmt[] | string;

  constructor(list: readonly Stmt[]) {
    this.prologue = prologueOf(list);
    // Lists whose prologues are the same statement objects share verdicts.
    this.prologueKey = this.prologue.length === 0 ? NO_PROLOGUE : prologueKeyOf(this.prologue);
    for (const s of list) this.add(s, 1);
  }

  private conflicted(n: string): boolean {
    const l = this.lex.get(n) ?? 0;
    return l > 1 || (l >= 1 && (this.vars.get(n) ?? 0) >= 1);
  }

  private touch(n: string, f: () => void): void {
    const was = this.conflicted(n);
    f();
    const now = this.conflicted(n);
    if (was !== now) this.conflicts += now ? 1 : -1;
  }

  add(s: Stmt, d: 1 | -1): void {
    const f = factsOf(s);
    for (const n of f.used) bump(this.used, n, d);
    for (const n of f.bound) bump(this.bound, n, d);
    for (const n of f.lex) this.touch(n, () => bump(this.lex, n, d));
    for (const n of f.vars) this.touch(n, () => bump(this.vars, n, d));
    if (f.opaque) this.opaque += d;
    if (!standalone(s, this.prologue, this.prologueKey)) this.bad += d;
  }

  /** The scoped parse verdict when it is decisive, else `null`. */
  scopedParses(): true | null {
    return this.opaque === 0 && this.conflicts === 0 && this.bad === 0 ? true : null;
  }
}

const prologueIds = new WeakMap<Stmt, number>();
let nextPrologueId = 1;
/** A canonical key for a prologue's statement identities. */
function prologueKeyOf(p: readonly Stmt[]): string {
  const ids = p.map((s) => {
    let id = prologueIds.get(s);
    if (id === undefined) prologueIds.set(s, (id = nextPrologueId++));
    return id;
  });
  return ids.join(",");
}

const indexCache = new WeakMap<readonly Stmt[], ListIndex>();

function indexOf(list: readonly Stmt[]): ListIndex {
  let ix = indexCache.get(list);
  if (ix === undefined) indexCache.set(list, (ix = new ListIndex(list)));
  return ix;
}

/** Which implementation `checkOneStatementRewrite` runs: `scoped` (default),
 *  `whole` (the original whole-list print+compile and whole-list
 *  `freeNames`), or `both` (run both, throw on any disagreement; the
 *  differential test's mode). Read per call so a test can switch it. */
function mode(): "scoped" | "whole" | "both" {
  const v = process.env["HBC2JS_SCOPED_CHECK"];
  return v === "whole" || v === "both" ? v : "scoped";
}

/** Counters for the differential test: rewrites checked in `both` mode. */
export const scopedCheckStats = { compared: 0, parseFallbacks: 0 };

export type OneStmtVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const NOT_JS = "the rewritten statement list is not syntactically valid JavaScript";

/** The original form: `parses(after)`, then the first name of
 *  `freeNames(after)` (in its order) not in `freeNames(before)`. */
function wholeCheck(before: readonly Stmt[], after: readonly Stmt[]): OneStmtVerdict {
  if (!parses(after)) return { ok: false, reason: NOT_JS };
  const bf = freeNames(before);
  for (const n of freeNames(after)) if (!bf.has(n)) return { ok: false, reason: `the rewrite introduced the free name \`${n}\`` };
  return { ok: true };
}

function scopedCheck(before: readonly Stmt[], after: readonly Stmt[], i: number): OneStmtVerdict {
  const stub = before[i]!;
  const got = after[i]!;
  const ix = indexOf(before);
  // A statement at or before the end of the prologue could change the
  // prologue itself: not this file's case, so the original check decides.
  if (i <= ix.prologue.length) {
    indexCache.delete(before);
    return wholeCheck(before, after);
  }
  // Section 12 argument (b): free(after) \ free(before) can only contain
  // names used by `got` or bound by `stub`; decide each by counts.
  const fs = factsOf(stub);
  const fg = factsOf(got);
  const cnt = (m: Map<string, number>, n: string, inStub: boolean, inGot: boolean): number => (m.get(n) ?? 0) - (inStub ? 1 : 0) + (inGot ? 1 : 0);
  const freeBefore = (n: string): boolean => (ix.used.get(n) ?? 0) > 0 && (ix.bound.get(n) ?? 0) === 0;
  const freeAfter = (n: string): boolean => cnt(ix.used, n, fs.used.has(n), fg.used.has(n)) > 0 && cnt(ix.bound, n, fs.bound.has(n), fg.bound.has(n)) === 0;
  let newFree = false;
  for (const n of fg.used) if (freeAfter(n) && !freeBefore(n)) { newFree = true; break; }
  if (!newFree) for (const n of fs.bound) if (freeAfter(n) && !freeBefore(n)) { newFree = true; break; }
  // Move the index to `after` (the next rewrite's `before`).
  indexCache.delete(before);
  ix.add(stub, -1);
  ix.add(got, 1);
  indexCache.set(after, ix);
  if (ix.scopedParses() === null) {
    // Not decisive (a collision, a statement that fails alone, raw text):
    // the whole-list check decides, so the verdict is the original one.
    scopedCheckStats.parseFallbacks++;
    if (!parses(after)) return { ok: false, reason: NOT_JS };
  }
  // A new free name: report the very name the whole-list order reports.
  if (newFree) return wholeCheck(before, after);
  return { ok: true };
}

/** `parses(after)` and "no free name of `after` that `before` lacks", for a
 *  rewrite that replaced exactly the statement at index `i` (same length,
 *  every other element identical). Same verdict and same reason as the
 *  whole-list form, in time proportional to the replaced statements. */
export function checkOneStatementRewrite(before: readonly Stmt[], after: readonly Stmt[], i: number): OneStmtVerdict {
  const m = mode();
  if (m === "whole") return wholeCheck(before, after);
  if (m === "scoped") return scopedCheck(before, after, i);
  const w = wholeCheck(before, after);
  const s = scopedCheck(before, after, i);
  scopedCheckStats.compared++;
  if (w.ok !== s.ok || (!w.ok && !s.ok && w.reason !== s.reason)) throw new Error(`scoped check disagrees with the whole-list check at statement ${i}: whole ${JSON.stringify(w)}, scoped ${JSON.stringify(s)}`);
  return w;
}
