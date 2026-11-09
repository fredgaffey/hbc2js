// closure-inline matcher (docs/specs/passes/32-closure-inline.md section 2).
// One site, the whole function body, and a one-shot fixed point: `analyze`
// decides every top-level hoisted declaration in a constant number of walks
// (a per-declaration walk of a module factory with thousands of closures is
// quadratic -- the `fn-naming`/M5 lesson, `identUsesMany`'s doc), and
// `rewrite` moves all the accepted ones at once. The moves are independent: a
// read inside another moved function is a nested use and is refused.
import { identUsesMany, stmtLists, walk } from "../ast.ts";
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { closureFunctionId } from "../tree.ts";
import type { FunctionCfg } from "../tree.ts";

export interface ClosureInlineSite {
  /** Accepted declaration names, in body order. */
  readonly names: readonly string[];
}

const LOOPS = new Set(["while", "do-while", "for", "for-in", "for-of"]);
type Func = Stmt & { readonly k: "func" };

/** The direct child statement lists of `s` (nested functions excluded). */
function childLists(s: Stmt): readonly (readonly Stmt[])[] {
  switch (s.k) {
    case "if": return [s.then, s.else];
    case "while": case "do-while": case "for": case "for-in": case "for-of": case "labeled": return [s.body];
    case "try": return [s.block, s.handler, ...(s.finalizer !== undefined ? [s.finalizer] : [])];
    case "switch": return s.cases.map((c) => c.body);
    default: return [];
  }
}

/** Every outermost loop statement in `body` (a loop inside one is covered). */
function outermostLoops(body: readonly Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (LOOPS.has(s.k)) out.push(s);
      else for (const l of childLists(s)) visit(l);
    }
  };
  visit(body);
  return out;
}

/** Names some NESTED block of `body` declares, plus every `catch` parameter
 *  and loop binding: a binding that could shadow, at a read site, a name the
 *  moved closure uses. */
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

/** Names whose read is exactly the stored value of `x = name` / `let x =
 *  name`, whatever `x` is. That is how a source function DECLARATION
 *  surfaces (`r1.m = m`, `_e14_3 = _fn5`) and how the emitter spells a
 *  plain `CreateClosure` into a register (`r3 = _fn1`), which later rungs
 *  and readers key on (the class constructor binding, a reference copy). A
 *  store already sits where Hermes created the closure, so a move would
 *  only cost the declaration form. A read nested in a larger expression (an
 *  argument, a descriptor literal) is a function EXPRESSION's position. */
function declarationStores(body: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  for (const list of stmtLists(body)) {
    for (const s of list) {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "ident") out.add(s.expr.value.name);
      else if (s.k === "init" && s.value.k === "ident") out.add(s.value.name);
    }
  }
  return out;
}

/** Names passed directly to a runtime helper (`__hbc_makeGenerator(_fn4)`,
 *  the async spawn driver): the enclosing function's own generator/async
 *  rungs (spec 25/29) run LATER, in the parent's pipeline, and read this
 *  body's hoisted factory declarations as their evidence. */
function helperArgs(body: readonly Stmt[]): Set<string> {
  const out = new Set<string>();
  walk(body, { expr: (e) => {
    if (e.k === "call" && e.callee.k === "ident" && e.callee.name.startsWith("__hbc_")) for (const a of e.args) if (a.k === "ident") out.add(a.name);
  } });
  return out;
}

/** Every identifier mentioned anywhere in `f` (nested functions included). */
function mentioned(f: Func): Set<string> {
  const out = new Set<string>();
  walk([f], { expr: (e) => { if (e.k === "ident") out.add(e.name); } });
  for (const p of f.params) out.add(p.name);
  return out;
}

/** Opcodes Hermes emits ahead of a function's first user statement: the
 *  environment, parameters, constants, and every function DECLARATION's
 *  closure (declarations are created at entry). */
const PROLOGUE = /^(?:Create\w*Environment|GetParentEnvironment|LoadParam\w*|LoadConst\w*|Mov\w*|GetGlobalObject|DeclareGlobalVar|Create\w*Closure\w*|StoreN?P?ToEnvironment\w*|LoadThisNS|CoerceThisNS|GetNewTarget|ProfilePoint|AsyncBreakCheck)$/;

/** Source function indices whose closure the bytecode creates BEFORE the
 *  first non-prologue instruction: a source declaration (or an expression
 *  in the opening statement, where a move changes no order). The closure is
 *  already created at entry in the original, so hoisting is the faithful
 *  form. Unknown (no cfg): every closure counts as entry-created. Memoised
 *  per cfg: `match` and `check` ask on every driver iteration. */
const entryMemo = new WeakMap<FunctionCfg, Set<number>>();
export function entryCreated(cfg: FunctionCfg | undefined): Set<number> | null {
  if (cfg === undefined) return null;
  const hit = entryMemo.get(cfg);
  if (hit !== undefined) return hit;
  const insns = cfg.blocks.flatMap((b) => b.instructions).sort((a, b) => a.offset - b.offset);
  const out = new Set<number>();
  for (const insn of insns) {
    if (!PROLOGUE.test(insn.name)) break;
    const child = closureFunctionId(insn);
    if (child !== undefined) out.add(child);
  }
  entryMemo.set(cfg, out);
  return out;
}

const FN_COMMENT = /^fn#(\d+)\b/;
/** The bytecode function index from the emitter's `// fn#N "name"` line. */
function fnIndexOf(f: Func): number | null {
  for (const s of f.body) {
    if (s.k !== "comment") continue;
    const m = FN_COMMENT.exec(s.text);
    if (m !== null) return Number(m[1]);
  }
  return null;
}

/** Per top-level declaration: `ok` or the refusal reason. `entry` null =
 *  no bytecode evidence (hand-built tests): the prologue rule is skipped. */
export function analyze(body: readonly Stmt[], entry: Set<number> | null = null): Map<string, string> {
  const funcs = body.filter((s): s is Func => s.k === "func");
  const verdicts = new Map<string, string>();
  if (funcs.length === 0) return verdicts;
  const names = funcs.map((f) => f.name);
  const uses = identUsesMany(body, names);
  const inLoop = identUsesMany(outermostLoops(body), names);
  const stores = declarationStores(body);
  const shadow = nestedBindings(body);
  const helpers = helperArgs(body);
  const seen = new Set<string>();
  for (const f of funcs) {
    const n = f.name;
    if (seen.has(n)) { verdicts.set(n, "duplicate-name"); continue; }
    seen.add(n);
    const mine = mentioned(f);
    const u = uses.get(n)!;
    let reason = "ok";
    if (mine.has(n)) reason = "self-reference";
    else if (u.writes > 0) reason = "written";
    else if (u.nested > 0) reason = "nested-use";
    else if (u.reads !== 1) reason = u.reads === 0 ? "unused" : "multi-use";
    else if (inLoop.get(n)!.reads > 0) reason = "in-loop";
    else if (stores.has(n)) reason = "declaration-store";
    else if (helpers.has(n)) reason = "helper-arg";
    else if (entry !== null && (fnIndexOf(f) === null || entry.has(fnIndexOf(f)!))) reason = "entry-created";
    else for (const m of mine) if (shadow.has(m)) { reason = "shadowed"; break; }
    verdicts.set(n, reason);
  }
  // a name declared twice is ambiguous for both declarations
  for (const f of funcs) if (verdicts.get(f.name) === "duplicate-name") verdicts.set(f.name, "duplicate-name");
  return verdicts;
}

/** Verdict for the declaration at `body[index]` (tests, diagnostics). */
export function classify(body: readonly Stmt[], index: number): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const f = body[index];
  if (f === undefined || f.k !== "func") return { ok: false, reason: "not-a-declaration" };
  const r = analyze(body).get(f.name)!;
  return r === "ok" ? { ok: true } : { ok: false, reason: r };
}

export function findSite(body: readonly Stmt[], cfg?: FunctionCfg): ClosureInlineSite | null {
  const names = [...analyze(body, cfg === undefined ? null : entryCreated(cfg))].filter(([, r]) => r === "ok").map(([n]) => n);
  return names.length === 0 ? null : { names };
}

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], ClosureInlineSite> | null {
  if (list !== ctx.fnBody) return null;
  // Never the global function: a bundle's `__d(_fnN, id, deps)` module
  // factories are read once each, as call arguments, and `--split` (and the
  // module reader) find them as hoisted declarations.
  if (ctx.module?.isGlobalFunction(ctx.functionIndex) === true) return null;
  const site = findSite(list, ctx.cfg);
  if (site === null) return null;
  return { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
