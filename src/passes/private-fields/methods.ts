// private-fields, private-methods step -- docs/specs/passes/24-class-recover.md
// section 1.7.1. Runs inside `foldAll` ahead of the per-field fold, so the
// field fold sees a private method's body as an ordinary class member.
//
// hermesc lowers `#m(...) {...}` to a brand symbol `B = Symbol("<Class>")`
// the constructor installs like a field, a function `function _fnK` (recorded
// name `"#m"`) created once in the defining frame and stored after the class
// in an env slot `M = _fnK`, and at each `recv.#m(args)` a brand check
// (`L: { t = hasOwn(recv, B); if (t) break L; ...throwTypeError(...); break L; }`)
// followed by `Reflect.apply(M, recv, [args])`. This step, all or nothing per
// class:
//   (1) moves `_fnK` into the class as `#m(params) { body }`;
//   (2) rewrites each `Reflect.apply(M, recv, [a...])` to `recv.#m(a...)` --
//       only where a recognised brand check on the same receiver dominates it
//       with no write to that receiver in between (`scanList`);
//   (3) folds the brand itself with `foldOne` (install + double-init guard
//       dropped, `hasOwn(x, B)` -> `#m in x`, creation dropped, R-PF1), then
//       discards the field declaration `foldOne` adds for it;
//   (4) drops the slot stores and their `let`s.
// Any mention of `_fnK`, M or B left over refuses the class (refusal codes
// below); `before` is then untouched and the field fold proceeds as before.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, identUsesMany, isHelperCall, mapStmts, walk } from "../ast.ts";
import { ctorBody, ENV_SLOT, findCandidates, findClass, foldOne, hasOwnCall, registerReadReached, simpleStore } from "./match.ts";
import type { FoldScope } from "./match.ts";

type ClassExpr = Extract<Expr, { k: "class" }>;
type FuncStmt = Extract<Stmt, { k: "func" }>;

/** Refusal codes (also reported by tools/passes/private-fields-refusals.ts). */
export const PM_REFUSAL = {
  noClass: "pm-no-class",
  noCtor: "pm-no-constructor",
  noBrand: "pm-no-brand",
  methodEscape: "pm-method-escape",
  slotRewritten: "pm-slot-rewritten",
  innerName: "pm-inner-name",
  undominated: "pm-undominated-call",
  slotEscape: "pm-slot-escape",
  brandEscape: "pm-brand-escape",
} as const;

export type MethodsOutcome =
  | { readonly tree: readonly Stmt[]; readonly methods: readonly string[]; readonly fnNames: readonly string[]; readonly slots: readonly string[] }
  | { readonly refused: string; readonly detail: string };

/** `fn#2 "#bump"` -- the function-header comment the emitter writes. */
const METHOD_COMMENT = /^\s*fn#\d+ "(#[A-Za-z_$][\w$]*)"\s*$/;

/** `Symbol("Counter")`: a symbol whose description does not start with `#`. */
export function brandSymbolName(e: Expr): string | null {
  if (e.k !== "call" || e.callee.k !== "ident" || e.callee.name !== "Symbol" || e.args.length !== 1) return null;
  const a = e.args[0]!;
  if (a.k !== "lit" || a.text.length < 3 || a.text[0] !== '"' || a.text[1] === "#" || a.text[a.text.length - 1] !== '"') return null;
  return a.text.slice(1, -1);
}

function methodName(f: FuncStmt): string | null {
  for (const s of f.body) {
    if (s.k === "comment") {
      const m = METHOD_COMMENT.exec(s.text);
      if (m !== null) return m[1]!;
    } else if (s.k !== "directive") return null;
  }
  return null;
}

interface Method { readonly slot: string; readonly fn: FuncStmt; readonly display: string; readonly reg: string | null }

/** Top-level function declarations whose recorded name is `#...`. */
export function methodFns(list: readonly Stmt[]): Map<string, FuncStmt> {
  const fns = new Map<string, FuncStmt>();
  for (const s of list) if (s.k === "func" && methodName(s) !== null) fns.set(s.name, s);
  return fns;
}

/** `null`: no private method in scope (nothing to do, not a refusal).
 *  `outerFns`: the hosted shape (section 1.7.1) -- the class and slot stores
 *  sit in a labelled block placed directly in the function body, the method
 *  functions at that body's top level; the caller (`foldHosted`) deletes the
 *  declarations and checks the whole frame. */
export function foldMethods(before: readonly Stmt[], scope?: FoldScope, outerFns?: ReadonlyMap<string, FuncStmt>): MethodsOutcome | null {
  const fns = outerFns ?? methodFns(before);
  if (fns.size === 0) return null;
  const methods: Method[] = [];
  // `M = _fnK`, or through one register (`r3 = _fnK; ...; M = r3;`), the
  // same one-hop rule `findCandidates` follows for a symbol.
  const hop = new Map<string, string>();
  for (const s of before) {
    const st = simpleStore(s);
    if (st !== null && st.value.k === "ident" && fns.has(st.value.name) && !ENV_SLOT.test(st.name)) { hop.set(st.name, st.value.name); continue; }
    if (st !== null && ENV_SLOT.test(st.name) && st.value.k === "ident") {
      const fnName = fns.has(st.value.name) ? st.value.name : hop.get(st.value.name);
      if (fnName !== undefined) {
        const fn = fns.get(fnName)!;
        methods.push({ slot: st.name, fn, display: methodName(fn)!, reg: fns.has(st.value.name) ? null : st.value.name });
        hop.delete(st.value.name);
        continue;
      }
    }
    for (const r of [...hop.keys()]) if (identUses([s], r).writes > 0) hop.delete(r);
  }
  if (methods.length === 0) return null;
  const refuse = (refused: string, detail: string): MethodsOutcome => ({ refused, detail });
  const cls = findClass(before);
  if (cls === null) return refuse(PM_REFUSAL.noClass, "no single recovered class in scope");
  if (ctorBody(cls) === null) return refuse(PM_REFUSAL.noCtor, "class has no constructor member");

  if (methods.length !== fns.size) {
    const paired = new Set(methods.map((m) => m.fn.name));
    const lone = [...fns.keys()].filter((n) => !paired.has(n));
    return refuse(PM_REFUSAL.methodEscape, `${lone.join(", ")}: not stored once into a slot beside the class`);
  }
  const frameOf = outerFns !== undefined && scope?.fnBody !== undefined ? scope.fnBody : before;
  const uses = identUsesMany(frameOf, [...methods.map((m) => m.fn.name), ...methods.map((m) => m.slot)]);
  const seen = new Set<string>();
  for (const m of methods) {
    const f = uses.get(m.fn.name)!;
    if (f.reads !== 1 || f.writes !== 0 || seen.has(m.display) || seen.has(m.slot)) return refuse(PM_REFUSAL.methodEscape, `${m.display}: ${m.fn.name} is mentioned outside its one slot store`);
    seen.add(m.display);
    seen.add(m.slot);
    const reg = m.reg;
    // The hop register is def-use checked like a symbol's (spec 24 section
    // 1.7): only a read the `reg = _fnK` store still reaches counts.
    if (reg !== null && registerReadReached(before, reg, (x) => { const st = simpleStore(x); return st !== null && st.name === reg && st.value.k === "ident" && st.value.name === m.fn.name; }, (x) => { const st = simpleStore(x); return st !== null && st.name === m.slot && st.value.k === "ident" && st.value.name === reg; }, scope)) return refuse(PM_REFUSAL.methodEscape, `${m.display}: register ${m.reg} holding ${m.fn.name} is read where the function may still be in it`);
    if (uses.get(m.slot)!.writes !== 1) return refuse(PM_REFUSAL.slotRewritten, `${m.display}: slot ${m.slot} written more than once`);
    if (cls.name !== null) {
      const u = identUses(m.fn.body, cls.name);
      if (u.reads + u.writes + u.nested > 0) return refuse(PM_REFUSAL.innerName, `${m.display} names ${cls.name}, the class's inner binding`);
    }
  }
  const brands = findCandidates(before, brandSymbolName).filter((c) => (cls.name === null || c.displayName === cls.name) && ENV_SLOT.test(c.envName));
  if (brands.length !== 1) return refuse(PM_REFUSAL.noBrand, `${brands.length} brand symbol candidate(s)`);
  const brand = brands[0]!;

  // (1) move the functions into the class.
  const slots = new Map(methods.map((m) => [m.slot, m.display] as const));
  const moved = methods.map((m) => ({
    kind: "method" as const, static: false, computed: false, key: { k: "lit" as const, text: m.display },
    value: { k: "func" as const, name: null, params: m.fn.params, body: m.fn.body, ...(m.fn.generator ? { generator: true as const } : {}), ...(m.fn.async ? { async: true as const } : {}) },
  }));
  // (2) rewrite the dominated calls in every member body.
  const flags = { undominated: false, escape: false };
  const members = [...cls.members, ...moved].map((m) => {
    if (m.value === null || m.value.k !== "func") return m;
    return { ...m, value: { ...m.value, body: scanList(m.value.body, emptyState(), { slots, brand: brand.envName, flags, breaks: new Map() }) } };
  });
  if (flags.undominated) return refuse(PM_REFUSAL.undominated, "a Reflect.apply of a method slot has no dominating brand check on its receiver");
  if (flags.escape) return refuse(PM_REFUSAL.slotEscape, "a register holding a method is read outside a call");
  const newCls: ClassExpr = { ...cls, members };
  const fnNames = new Set(methods.map((m) => m.fn.name));
  const regs = new Set(methods.flatMap((m) => (m.reg === null ? [] : [m.reg])));
  const stripped = before.flatMap((s): Stmt[] => {
    if (s.k === "func" && fnNames.has(s.name)) return [];
    const st = simpleStore(s);
    if (st !== null && slots.has(st.name)) return [];
    if (st !== null && regs.has(st.name) && st.value.k === "ident" && fnNames.has(st.value.name)) return s.k === "init" ? [{ k: "decl", kind: s.kind, names: [st.name] }] : [];
    return [s];
  });
  const tree2 = mapStmts(stripped, (st) => st, (e) => (e === cls ? newCls : e));
  const left = identUsesMany(tree2, [...slots.keys()]);
  for (const [n, u] of left) if (u.reads + u.writes + u.nested > 0) return refuse(PM_REFUSAL.slotEscape, `method slot ${n} is still mentioned`);

  // (3) the brand, through the field fold's own machinery.
  const display = methods[0]!.display;
  const before3 = countPrivateMembers(tree2, display);
  const folded = foldOne(tree2, { envName: brand.envName, displayName: display, regName: brand.regName, brand: true }, scope);
  if (folded === null || countPrivateMembers(folded, display) !== before3) return refuse(PM_REFUSAL.brandEscape, `brand ${brand.envName} has a use the brand fold does not place`);
  const cls3 = findClass(folded)!;
  const cls4: ClassExpr = { ...cls3, members: cls3.members.filter((m) => !(m.kind === "field" && m.key.k === "lit" && m.key.text === display)) };
  const tree4 = mapStmts(folded, (st) => st, (e) => (e === cls3 ? cls4 : e));
  // (4) the slots' declarations.
  const tree = tree4.map((st) => (st.k === "decl" ? { ...st, names: st.names.filter((n) => !slots.has(n)) } : st)).filter((st) => !(st.k === "decl" && st.names.length === 0));
  return { tree, methods: methods.map((m) => m.display), fnNames: [...fnNames], slots: [...slots.keys(), brand.envName] };
}

/** `obj.#name` member nodes (reads, writes and calls). The brand fold must not
 *  add any: B is never read as a property key, so a new one would be a
 *  `x[B]` read turned into a method read. */
function countPrivateMembers(stmts: readonly Stmt[], display: string): number {
  let n = 0;
  walk(stmts, { expr: (e) => { if (e.k === "member" && !e.computed && e.prop.k === "lit" && e.prop.text === display) n++; } });
  return n;
}

// ---------------------------------------------------------------------------
// Dominance scan over one member body.
// ---------------------------------------------------------------------------

interface ScanState {
  /** Receivers (register name, or "this") a completed brand check proved. */
  readonly branded: Set<string>;
  /** Registers that hold a method slot's value right now (store dropped). */
  readonly alias: Map<string, string>;
  /** Registers that MAY hold a method through a dropped store: any read refuses. */
  readonly maybe: Set<string>;
  /** Registers holding the brand symbol. */
  readonly balias: Set<string>;
}
interface ScanCtx { readonly slots: ReadonlyMap<string, string>; readonly brand: string; readonly flags: { undominated: boolean; escape: boolean }; readonly breaks: Map<string, ScanState[]> }

const emptyState = (): ScanState => ({ branded: new Set(), alias: new Map(), maybe: new Set(), balias: new Set() });
const clone = (s: ScanState): ScanState => ({ branded: new Set(s.branded), alias: new Map(s.alias), maybe: new Set(s.maybe), balias: new Set(s.balias) });
const tracked = (s: ScanState): string[] => [...new Set([...s.branded, ...s.alias.keys(), ...s.maybe, ...s.balias])].filter((n) => n !== "this");
const recvKey = (e: Expr): string | null => (e.k === "this" ? "this" : e.k === "ident" ? e.name : null);

/** The facts that hold on every one of `outs` (a register that holds a method
 *  on some but not all of them becomes "maybe"). */
function meet(outs: readonly ScanState[]): ScanState {
  const r = clone(outs[0]!);
  for (const o of outs.slice(1)) {
    for (const n of [...r.branded]) if (!o.branded.has(n)) r.branded.delete(n);
    for (const n of [...r.balias]) if (!o.balias.has(n)) r.balias.delete(n);
    for (const [n, d] of [...r.alias]) if (o.alias.get(n) !== d) { r.alias.delete(n); r.maybe.add(n); }
    for (const n of o.alias.keys()) if (!r.alias.has(n)) r.maybe.add(n);
    for (const n of o.maybe) r.maybe.add(n);
  }
  for (const n of r.alias.keys()) r.maybe.delete(n);
  return r;
}

function written(stmts: readonly Stmt[], names: readonly string[]): Set<string> {
  const u = identUsesMany(stmts, names);
  return new Set(names.filter((n) => u.get(n)!.writes > 0));
}

/** Child statement lists of a compound statement, and the statement with
 *  them emptied (its head expressions only), or null for a plain statement. */
function children(s: Stmt): { readonly lists: readonly (readonly Stmt[])[]; readonly head: Stmt; readonly rebuild: (ls: readonly (readonly Stmt[])[]) => Stmt } | null {
  switch (s.k) {
    case "if": return { lists: [s.then, s.else], head: { ...s, then: [], else: [] }, rebuild: (l) => ({ ...s, then: l[0]!, else: l[1]! }) };
    case "labeled": return { lists: [s.body], head: { ...s, body: [] }, rebuild: (l) => ({ ...s, body: l[0]! }) };
    case "while": case "do-while": case "for": case "for-in": case "for-of": return { lists: [s.body], head: { ...s, body: [] }, rebuild: (l) => ({ ...s, body: l[0]! }) as Stmt };
    case "try": return { lists: [s.block, s.handler, s.finalizer ?? []], head: { ...s, block: [], handler: [], finalizer: [] }, rebuild: (l) => ({ ...s, block: l[0]!, handler: l[1]!, ...(s.finalizer !== undefined ? { finalizer: l[2]! } : {}) }) };
    case "switch": return { lists: s.cases.map((c) => c.body), head: { ...s, cases: s.cases.map((c) => ({ ...c, body: [] })) }, rebuild: (l) => ({ ...s, cases: s.cases.map((c, i) => ({ ...c, body: l[i]! })) }) };
    case "iife": return { lists: [s.body], head: { ...s, body: [] }, rebuild: (l) => ({ ...s, body: l[0]! }) };
    default: return null;
  }
}

/** Registers a slot is stored into anywhere inside `s` (the stores this scan drops). */
function aliasTargets(s: Stmt, ctx: ScanCtx): Set<string> {
  const out = new Set<string>();
  walk([s], { stmt: (x: Stmt) => { const st = simpleStore(x); if (st !== null && st.value.k === "ident" && ctx.slots.has(st.value.name)) out.add(st.name); } });
  return out;
}

function scanList(list: readonly Stmt[], st: ScanState, ctx: ScanCtx): Stmt[] {
  const out: Stmt[] = [];
  for (const s of list) {
    const ch = children(s);
    if (ch !== null) {
      // Head expressions (tests, discriminants) are not rewritten; they may
      // not read a register that holds a method.
      checkReads(ch.head, st, ctx);
      const straight = s.k === "if" || s.k === "labeled";
      const inner = clone(st);
      const all = tracked(st);
      if (!straight) {
        // Loops / try / switch: any child list may run after any other part
        // of `s` (back-edge, throw), so enter with every fact `s` might kill
        // already killed and every alias `s` creates already "maybe".
        const w = written([s], all);
        for (const n of w) { inner.branded.delete(n); inner.balias.delete(n); if (inner.alias.delete(n)) inner.maybe.add(n); }
        for (const n of aliasTargets(s, ctx)) inner.maybe.add(n);
      }
      const recv = s.k === "labeled" ? brandCheckReceiver(s, st, ctx) : null;
      const saved = s.k === "labeled" ? ctx.breaks.get(s.label) : undefined;
      if (s.k === "labeled") ctx.breaks.set(s.label, []);
      const outs: ScanState[] = [];
      const lists = ch.lists.map((l) => { const s2 = clone(inner); const r = scanList(l, s2, ctx); outs.push(s2); return r; });
      const rebuilt = ch.rebuild(lists);
      if (straight) {
        // `if` / labelled block: the state after `s` is the meet of every way
        // out of it -- each arm's end, and for a block each `break` to it.
        if (s.k === "labeled") { outs.push(...ctx.breaks.get(s.label)!); if (saved === undefined) ctx.breaks.delete(s.label); else ctx.breaks.set(s.label, saved); }
        const met = meet(outs);
        st.branded.clear(); for (const n of met.branded) st.branded.add(n);
        st.balias.clear(); for (const n of met.balias) st.balias.add(n);
        st.alias.clear(); for (const [n, d] of met.alias) st.alias.set(n, d);
        st.maybe.clear(); for (const n of met.maybe) st.maybe.add(n);
        if (recv !== null) st.branded.add(recv);
      } else {
        const w = written([s], [...new Set([...all, ...outs.flatMap(tracked)])]);
        for (const n of w) { st.branded.delete(n); st.balias.delete(n); if (st.alias.delete(n)) st.maybe.add(n); }
        for (const o of outs) { for (const n of o.alias.keys()) if (!st.alias.has(n)) st.maybe.add(n); for (const n of o.maybe) st.maybe.add(n); }
      }
      out.push(rebuilt);
      continue;
    }
    if (s.k === "func") { out.push({ ...s, body: scanList(s.body, emptyState(), { ...ctx, breaks: new Map() }) }); continue; }
    if (s.k === "break" && s.label !== null) ctx.breaks.get(s.label)?.push(clone(st));
    const store = simpleStore(s);
    if (store !== null && store.value.k === "ident" && ctx.slots.has(store.value.name)) {
      st.alias.set(store.name, ctx.slots.get(store.value.name)!);
      st.maybe.delete(store.name);
      st.branded.delete(store.name);
      st.balias.delete(store.name);
      if (s.k === "init") out.push({ k: "decl", kind: s.kind, names: [store.name] });
      continue;
    }
    const rewritten = rewriteCalls(s, st, ctx);
    checkReads(rewritten, st, ctx);
    for (const n of written([s], tracked(st))) {
      st.branded.delete(n);
      st.balias.delete(n);
      if (st.alias.delete(n) && store?.name !== n) st.maybe.add(n);
      if (store?.name === n) st.maybe.delete(n);
    }
    if (store !== null && store.value.k === "ident" && (store.value.name === ctx.brand || st.balias.has(store.value.name))) st.balias.add(store.name);
    out.push(rewritten);
  }
  return out;
}

function checkReads(s: Stmt, st: ScanState, ctx: ScanCtx): void {
  const names = [...st.alias.keys(), ...st.maybe];
  if (names.length === 0) return;
  const u = identUsesMany([s], names);
  for (const n of names) if (u.get(n)!.reads > 0) ctx.flags.escape = true;
}

/** `Reflect.apply(C, recv, [args])` -> `recv.#m(args)` where C names a method
 *  (slot or alias register) and `recv` is branded and not written by `s`
 *  other than as `s`'s own store target. Never enters a nested function. */
function rewriteCalls(s: Stmt, st: ScanState, ctx: ScanCtx): Stmt {
  const store = simpleStore(s);
  const unwrittenHere = (name: string): boolean => {
    const where = store !== null && store.name === name ? [{ k: "expr" as const, expr: store.value }] : [s];
    return identUses(where, name).writes === 0;
  };
  const f = (e: Expr): Expr | null => {
    if (e.k !== "call" || e.args.length !== 3 || e.callee.k !== "member" || e.callee.computed) return null;
    const c = e.callee;
    if (c.obj.k !== "ident" || c.obj.name !== "Reflect" || c.prop.k !== "lit" || c.prop.text !== "apply") return null;
    const [callee, recv, arr] = e.args as [Expr, Expr, Expr];
    if (callee.k !== "ident") return null;
    const display = ctx.slots.get(callee.name) ?? st.alias.get(callee.name);
    if (display === undefined) return null;
    const key = recvKey(recv);
    if (arr.k !== "array" || key === null || !st.branded.has(key) || (key !== "this" && !unwrittenHere(key)) || !unwrittenHere(callee.name)) {
      ctx.flags.undominated = true;
      return null;
    }
    return { k: "call", callee: { k: "member", obj: recv, prop: { k: "lit", text: display }, computed: false }, args: arr.elements };
  };
  return mapShallow(s, f, ctx) as Stmt;
}

/** Every nested function is its own frame (fresh registers): scan it from an
 *  empty state. A `sameFrame` resume closure shares this frame's registers
 *  and is left alone (any method mention in it then refuses). */
function scanNested(fn: Extract<Expr, { k: "func" }>, ctx: ScanCtx): Expr {
  if (fn.sameFrame === true) return fn;
  return { ...fn, body: scanList(fn.body, emptyState(), { ...ctx, breaks: new Map() }) };
}

function mapShallow(n: unknown, f: (e: Expr) => Expr | null, ctx: ScanCtx): unknown {
  if (Array.isArray(n)) {
    let changed = false;
    const out = n.map((x) => { const y = mapShallow(x, f, ctx); if (y !== x) changed = true; return y; });
    return changed ? out : n;
  }
  if (n === null || typeof n !== "object") return n;
  const o = n as { readonly k?: string };
  if (o.k === "func") return scanNested(n as Extract<Expr, { k: "func" }>, ctx);
  if (o.k === "class" || o.k === "arrow") return n;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(o)) { const y = mapShallow(v, f, ctx); if (y !== v) changed = true; out[key] = y; }
  const node = (changed ? out : o) as Expr;
  return (typeof node.k === "string" ? f(node) : null) ?? node;
}

/** The brand-check block hermesc emits before a private-method call:
 *  `L: { ...; t = hasOwn(recv, B); if (t) { break L; } (lit stores)*;
 *  [x =] throwTypeError(...); break L; }` with no other exit from `L` before
 *  the check. The block completes normally only when `recv` has the brand.
 *  Returns the receiver key, or null. */
function brandCheckReceiver(s: Extract<Stmt, { k: "labeled" }>, st: ScanState, ctx: ScanCtx): string | null {
  const b = s.body;
  const n = b.length;
  if (n < 4) return null;
  const last = b[n - 1]!;
  if (last.k !== "break" || last.label !== s.label) return null;
  const isThrow = (x: Stmt): boolean => {
    const v = x.k === "expr" ? (x.expr.k === "assign" && x.expr.target.k === "ident" ? x.expr.value : x.expr) : x.k === "init" ? x.value : null;
    return v !== null && isHelperCall(v, "__hbc_b_throwTypeError");
  };
  if (!isThrow(b[n - 2]!)) return null;
  let j = n - 3;
  while (j >= 0) { const x = simpleStore(b[j]!); if (x === null || x.value.k !== "lit") break; j--; }
  const test = b[j];
  if (test === undefined || test.k !== "if" || test.test.k !== "ident" || test.else.length !== 0 || test.then.length !== 1) return null;
  const br = test.then[0]!;
  if (br.k !== "break" || br.label !== s.label) return null;
  const t = test.test.name;
  const chk = j >= 1 ? simpleStore(b[j - 1]!) : null;
  if (chk === null || chk.name !== t) return null;
  const args = hasOwnCall(chk.value);
  if (args === null || args[1]!.k !== "ident") return null;
  const key = recvKey(args[0]!);
  if (key === null || key === t) return null;
  const prefix = b.slice(0, j - 1);
  let exits = false;
  walk(prefix, { stmt: (x: Stmt) => { if ((x.k === "break" || x.k === "continue") && x.label === s.label) exits = true; } });
  if (exits) return null;
  // Is the key argument the brand at the check? Recompute over the prefix.
  const bal = new Set(st.balias);
  for (const x of prefix) {
    const xs = simpleStore(x);
    for (const w of written([x], [...bal])) bal.delete(w);
    if (xs !== null && xs.value.k === "ident" && (xs.value.name === ctx.brand || bal.has(xs.value.name)) && children(x) === null) bal.add(xs.name);
    else if (children(x) !== null) for (const w of written([x], [...bal])) bal.delete(w);
  }
  const k1 = (args[1] as Extract<Expr, { k: "ident" }>).name;
  return k1 === ctx.brand || bal.has(k1) ? key : null;
}
