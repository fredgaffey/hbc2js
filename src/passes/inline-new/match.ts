// inline-new matcher -- docs/specs/passes/24-class-recover.md section 9.
//
// hermesc's inliner splices `new C(args)` of a class it can see into the
// calling frame: the receiver (`X = C.prototype; X = Object.create(...)`, or
// for a derived class `Reflect.construct(Object.getPrototypeOf(C), [...], C)`)
// followed by a copy of the constructor's body with `this` := X. This rung
// rebuilds that region as `X = new C(args)` when it is PROVABLY a copy of the
// recovered class's own constructor body: a lock-step symbolic comparison of
// the two statement lists over value tokens (section 9.2). Everything else is
// refused with an R-IN code (section 9.3) and left exactly as it was.
import type { Expr, Stmt } from "../ast.ts";
import { stmtLists, walk } from "../ast.ts";

type ClassExpr = Extract<Expr, { k: "class" }>;
/** The class's own `constructor` member, exactly as `class-recover` installs it. */
function ctorMember(cls: ClassExpr): Extract<Expr, { k: "func" }> | null {
  const m = cls.members.find((m) => m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor");
  return m !== undefined && m.value !== null && m.value.k === "func" ? m.value : null;
}

export type RefusalCode = "R-IN1" | "R-IN2" | "R-IN3" | "R-IN4" | "R-IN5" | "R-IN6" | "R-IN7";
export interface Refusal { readonly code: RefusalCode; readonly reason: string }
export interface InlineNewGroup { readonly folded: number }

const ENV_SLOT = /^_e\d+_\d+$/;
const OBJ = "obj";
const SUPER_TWICE = '"super() called twice"';
const THROW_HELPER = "__hbc_b_throwTypeError";

type Env = Map<string, string>;
class Fail extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, reason: string) { super(reason); this.code = code; }
}
const fail = (code: RefusalCode, reason: string): never => { throw new Fail(code, reason); };

const ident = (name: string): Expr => ({ k: "ident", name });
const isIdent = (e: Expr | undefined, name?: string): e is Extract<Expr, { k: "ident" }> => e !== undefined && e.k === "ident" && (name === undefined || e.name === name);

/** `name = value;` / `let name = value;` -- a store to a plain identifier. */
function store(s: Stmt | undefined): { readonly name: string; readonly value: Expr; readonly decl: boolean } | null {
  if (s === undefined) return null;
  if (s.k === "init") return { name: s.name, value: s.value, decl: true };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value, decl: false };
  return null;
}
/** A store that runs no user code and whose value is a token (section 9.2). */
const silent = (s: Stmt): boolean => {
  if (s.k === "decl") return true;
  const st = store(s);
  return st !== null && (st.value.k === "ident" || st.value.k === "lit");
};
const skippable = (s: Stmt): boolean => s.k === "comment" || s.k === "directive";

function mentions(s: Stmt | readonly Stmt[], name: string): boolean {
  let found = false;
  walk(Array.isArray(s) ? (s as readonly Stmt[]) : [s as Stmt], { expr: (e) => { if (e.k === "ident" && e.name === name) found = true; } });
  return found;
}
function hasKind(stmts: readonly Stmt[], kinds: ReadonlySet<string>, intoFuncs: boolean): boolean {
  let found = false;
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (kinds.has(s.k)) found = true;
      if (s.k === "func" && !intoFuncs) continue;
      for (const v of Object.values(s)) if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && "k" in v[0]) visit(v as Stmt[]);
      if (s.k === "try" && s.finalizer !== undefined) visit(s.finalizer as readonly Stmt[]);
      if (s.k === "switch") for (const c of s.cases) visit(c.body);
    }
  };
  visit(stmts);
  return found;
}
const JUMPS = new Set(["break", "continue"]);
const CONTROL = new Set(["if", "while", "do-while", "for", "for-in", "for-of", "labeled", "break", "continue", "return", "throw", "try", "switch"]);

/** Tokens: `lit:<text>`, `id:<name>` (unchanged since the scan began), `w:<n>`
 *  (a value written in the scan), `cls:<n>`, `obj` (the receiver). */
class Tokens {
  private n = 0;
  fresh(): string { return `w:${this.n++}`; }
  /** Write `name` with token `t` (or a fresh one), first freeing every alias
   *  that still names its previous value. */
  write(env: Env, name: string, t?: string): void {
    const old = `id:${name}`;
    let moved: string | null = null;
    for (const [k, v] of env) if (v === old) env.set(k, (moved ??= this.fresh()));
    env.set(name, t ?? this.fresh());
  }
  /** User code may have run: every env slot not proven to hold a class for
   *  the module's life is a fresh unknown. */
  clobberSlots(env: Env, keep: ReadonlySet<string>): void {
    const names = new Set<string>();
    for (const [k, v] of env) { if (ENV_SLOT.test(k)) names.add(k); if (v.startsWith("id:") && ENV_SLOT.test(v.slice(3))) names.add(v.slice(3)); }
    for (const k of names) if (!keep.has(k)) this.write(env, k);
  }
}
const tokOf = (env: Env, e: Expr): string | null => (e.k === "lit" ? `lit:${e.text}` : e.k === "ident" ? (env.get(e.name) ?? `id:${e.name}`) : null);

interface Frame { readonly body: readonly Stmt[]; readonly isRoot: boolean; readonly declared: ReadonlySet<string> }
interface Level { readonly list: readonly Stmt[]; readonly at: number; readonly label: string | null }

interface ClassInfo { readonly cls: ClassExpr; readonly ctor: Extract<Expr, { k: "func" }> }

export interface FoldResult { readonly after: readonly Stmt[]; readonly folded: number }

/** Section 9: rebuild every provable inlined construction in `root` (the
 *  frame that defines the classes) and in the functions declared directly in
 *  it. Pure: `check` re-runs it on `before` and requires the same answer. */
export function foldAll(root: readonly Stmt[], onRefuse?: (r: Refusal) => void, onSkip?: (why: string) => void): FoldResult {
  const toks = new Tokens();
  const classes = new Map<string, ClassInfo>();
  const keepSlots = new Set<string>();
  const seed: Env = new Map();
  let ci = 0;
  for (const list of stmtLists(root)) for (const s of list) {
    const st = store(s);
    if (st === null || st.value.k !== "class") continue;
    const ctor = ctorMember(st.value);
    if (ctor === null) continue;
    const t = `cls:${ci++}`;
    classes.set(t, { cls: st.value, ctor });
  }
  if (classes.size === 0) return { after: root, folded: 0 };
  // Section 9.2 (2): an env slot whose ONLY write in the module is one store
  // in the defining frame's straight-line lists holds one value per
  // environment from that store on -- no user code can write it again.
  const writes = new Map<string, number>();
  walk(root, {
    expr: (e) => { if (e.k === "assign" && e.target.k === "ident" && ENV_SLOT.test(e.target.name)) writes.set(e.target.name, (writes.get(e.target.name) ?? 0) + 1); },
    stmt: (s) => { if (s.k === "init" && ENV_SLOT.test(s.name)) writes.set(s.name, (writes.get(s.name) ?? 0) + 2); },
  });
  // A kept slot stored straight from a register that still holds a class
  // (`H = class ...; ...; _eD_S = H;`, no write to H between) holds that
  // class: nested frames start from it (spec 28's R-SC1 evidence, restated).
  const straight = (list: readonly Stmt[], holders: Map<string, string>): void => {
    for (const s of list) {
      const st = store(s);
      if (st !== null && !st.decl && writes.get(st.name) === 1) keepSlots.add(st.name);
      if (st !== null && st.value.k === "ident" && keepSlots.has(st.name) && holders.has(st.value.name)) seed.set(st.name, holders.get(st.value.name)!);
      const cls = st !== null && st.value.k === "class" ? [...classes].find(([, c]) => c.cls === st.value)?.[0] : undefined;
      if (s.k === "labeled") straight(s.body, new Map(holders));
      walk([s], { expr: (e) => { if (e.k === "assign" && e.target.k === "ident") holders.delete(e.target.name); }, stmt: (x) => { if (x.k === "init") holders.delete(x.name); } });
      if (st !== null && cls !== undefined) holders.set(st.name, cls);
    }
  };
  straight(root, new Map());
  let folded = 0;
  const run = (frame: Frame, env0: Env): readonly Stmt[] => {
    if (hasKind(frame.body, new Set(["try"]), false)) { onSkip?.("R-IN6 frame has try"); return frame.body; } // R-IN6, silent: no candidate is examined
    const scan = (list: readonly Stmt[], env: Env, chain: readonly Level[]): readonly Stmt[] => {
      const out: Stmt[] = [];
      let i = 0;
      while (i < list.length) {
        const s = list[i]!;
        const levels = [...chain, { list, at: i, label: null }];
        let hit: { end: number; stmts: readonly Stmt[] } | null = null;
        try {
          hit = region(list, i, env, levels, frame);
        } catch (e) {
          if (!(e instanceof Fail)) throw e;
          onRefuse?.({ code: e.code, reason: e.message });
        }
        if (hit !== null) {
          folded++;
          for (const r of hit.stmts) { out.push(r); step(r, env); }
          i = hit.end;
          continue;
        }
        if (s.k === "labeled") {
          const body = scan(s.body, new Map(env), [...chain, { list, at: i, label: s.label }]);
          out.push(body === s.body ? s : { ...s, body });
          // Every exit of `L: {...}` (its end, or a `break`) runs the body's
          // leading straight-line prefix in full, so what the prefix stored
          // survives the block unless a later statement in it writes again.
          let p = 0;
          while (p < s.body.length && !hasKind([s.body[p]!], CONTROL, false)) { step(s.body[p]!, env); p++; }
          const later = new Set<string>();
          walk(s.body.slice(p), { expr: (e) => { if (e.k === "assign" && e.target.k === "ident") later.add(e.target.name); }, stmt: (x) => { if (x.k === "init") later.add(x.name); if (x.k === "decl") for (const n of x.names) later.add(n); } });
          for (const n of later) toks.write(env, n);
          toks.clobberSlots(env, keepSlots);
          i++;
          continue;
        } else if (s.k === "func" && frame.isRoot) {
          const body = run({ body: s.body, isRoot: false, declared: declaredIn(s) }, new Map(seed));
          out.push(body === s.body ? s : { ...s, body });
        } else out.push(s);
        step(s, env);
        i++;
      }
      return out.length === list.length && out.every((x, k) => x === list[k]) ? list : out;
    };
    const step = (s: Stmt, env: Env): void => {
      if (skippable(s) || s.k === "func") return;
      const st = store(s);
      if (st !== null && silent(s)) { toks.write(env, st.name, tokOf(env, st.value) ?? undefined); return; }
      if (s.k === "decl") { for (const n of s.names) toks.write(env, n, "lit:undefined"); return; }
      if (st !== null && st.value.k === "class") { const t = [...classes].find(([, c]) => c.cls === st.value)?.[0]; toks.write(env, st.name, t); return; }
      const written = new Set<string>();
      walk([s], { expr: (e) => { if (e.k === "assign" && e.target.k === "ident") written.add(e.target.name); } });
      walk([s], { stmt: (x) => { if (x.k === "init") written.add(x.name); if (x.k === "decl") for (const n of x.names) written.add(n); } });
      for (const n of written) toks.write(env, n);
      toks.clobberSlots(env, keepSlots);
    };
    // Section 9.2: the candidate region at list[i].
    const region = (list: readonly Stmt[], i: number, envAt: Env, levels: readonly Level[], fr: Frame): { end: number; stmts: readonly Stmt[] } | null => {
      const env: Env = new Map(envAt);
      const h0 = store(list[i]);
      if (h0 === null || h0.decl) return null;
      let clsTok: string | null = null;
      let cExpr: Expr | null = null;
      let x: string;
      let j: number;
      const tenv: Env = new Map();
      const written = new Set<string>();
      const declaredHere = new Set<string>();
      const bound: (string | undefined)[] = [];
      let info: ClassInfo;
      let ti = 0;
      const body = (): readonly Stmt[] => info.ctor.body;
      const proto = h0.value;
      if (proto.k === "member" && !proto.computed && proto.prop.k === "lit" && proto.prop.text === "prototype" && proto.obj.k === "ident") {
        // Base header (section 9.1, H-B).
        // The receiver register X is usually the prototype's own register P,
        // but hermesc may allocate a second one (`P = C.prototype; X =
        // Object.create(P ...)`); then P is one more register the region
        // wrote, holding C.prototype, and section 9.2 (5) proves it dead or
        // re-stores it like any other.
        const t = tokOf(env, proto.obj);
        const hdr = createdFrom(list[i + 1], h0.name);
        if (t === null || !classes.has(t)) { if (hdr !== null) onSkip?.(`H-B class operand is not a class token (${t ?? "null"})`); return null; }
        if (classes.get(t)!.cls.superClass !== null) return null;
        if (hdr === null) return null;
        clsTok = t; cExpr = proto.obj; x = hdr; j = i + 2; info = classes.get(t)!;
        if (hdr !== h0.name) { toks.write(env, h0.name); written.add(h0.name); }
        toks.write(env, x, OBJ); written.add(x);
      } else if (proto.k === "call" && isMemberCall(proto.callee, "Object", "getPrototypeOf") && proto.args.length === 1 && isIdent(proto.args[0])) {
        // Derived header (section 9.1, H-D).
        const t = tokOf(env, proto.args[0]!);
        if (t === null || !classes.has(t)) { onSkip?.(`H-D class operand is not a class token (${t ?? "null"})`); return null; }
        if (classes.get(t)!.cls.superClass === null) return null;
        info = classes.get(t)!; clsTok = t; cExpr = proto.args[0]!;
        const pTok = toks.fresh();
        toks.write(env, h0.name, pTok); written.add(h0.name);
        j = i + 1;
        while (j < list.length && silent(list[j]!)) j = applyCaller(list[j]!, env, j);
        const rc = store(list[j]);
        if (rc === null || rc.decl || rc.value.k !== "call" || !isMemberCall(rc.value.callee, "Reflect", "construct")) { onSkip?.("H-D no Reflect.construct after the getPrototypeOf store"); return null; }
        const [p, arr, nt] = rc.value.args;
        if (rc.value.args.length !== 3 || p === undefined || arr === undefined || arr.k !== "array" || nt === undefined || tokOf(env, p) !== pTok || tokOf(env, nt) !== clsTok) { onSkip?.(`H-D Reflect.construct operands differ (args ${rc.value.args.length}, arr ${arr?.k}, p ${tokOf(env, p!) === pTok}, nt ${nt === undefined ? "-" : tokOf(env, nt) === clsTok ? "ok" : nt.k})`); return null; }
        // The template, up to its own super(...): silent stores only.
        checkTemplate(body());
        while (ti < body().length && (skippable(body()[ti]!) || silent(body()[ti]!))) { if (!skippable(body()[ti]!)) applyTemplate(body()[ti]!); ti++; }
        const sup = body()[ti];
        if (sup === undefined || sup.k !== "expr" || sup.expr.k !== "call" || sup.expr.callee.k !== "lit" || sup.expr.callee.text !== "super") fail("R-IN1", "the derived constructor has no leading super(...) after silent stores");
        const sargs = (sup as Extract<Stmt, { k: "expr" }>).expr as Extract<Expr, { k: "call" }>;
        if (sargs.args.length !== arr.elements.length || !sargs.args.every((a, k) => eq(a, arr.elements[k]!))) fail("R-IN2", "Reflect.construct's arguments are not the constructor's super(...) arguments");
        ti++;
        x = rc.name; j++;
        toks.write(env, x, OBJ); written.add(x);
      } else return null;
      void clsTok;
      // ---- from here on a refusal is a counted R-IN code ----
      if (fr.isRoot === false) for (const n of freeTemplateNames(info.ctor)) if (fr.declared.has(n)) fail("R-IN7", `the constructor's free name ${n} is declared in the calling frame`);
      checkTemplate(body());
      const t = body();
      while (ti < t.length) {
        const ts = t[ti]!;
        if (skippable(ts)) { ti++; continue; }
        if (silent(ts)) { applyTemplate(ts); ti++; continue; }
        // Caller-only statements: silent stores, and the dead double-super
        // guard hermesc leaves after the inlined Reflect.construct (its
        // register provably holds __hbc_empty, so the test is false).
        for (;;) {
          const c = list[j];
          if (c !== undefined && silent(c)) { j = applyCaller(c, env, j); continue; }
          if (c !== undefined && c.k === "if" && c.test.k === "bin" && isIdent(c.test.left) && isSuperTwiceGuard(c, c.test.left.name) && tokOf(env, c.test.left) === tokOf(env, ident("__hbc_empty"))) { j++; continue; }
          break;
        }
        if (j >= list.length) fail("R-IN2", "the calling frame ends before the constructor body does");
        const tc = condOf(t, ti);
        if (tc !== null) {
          const cc = condOf(list, j);
          if (cc === null) fail("R-IN2", "a constructor `if` has no counterpart");
          if (!eq(tc!.test, cc!.test)) fail("R-IN2", "an `if` test differs from the constructor's" + "");
          const tm = throwMessage(tc!.node.then, tenv, null);
          const cm = throwMessage(cc!.node.then, env, levels);
          if (tc!.node.else.length !== 0 || cc!.node.else.length !== 0 || tm === null || tm !== cm) fail("R-IN3", "an `if` is not the same TypeError throw on both sides");
          if (tc!.assigned !== null) toks.write(tenv, tc!.assigned);
          if (cc!.assigned !== null) { toks.write(env, cc!.assigned); written.add(cc!.assigned); }
          ti += tc!.consumed; j += cc!.consumed;
          toks.clobberSlots(env, keepSlots);
          continue;
        }
        const cs = list[j]!;
        if (ts.k !== "expr" && ts.k !== "init") fail("R-IN1", `constructor statement kind ${ts.k} is not supported`);
        if (cs.k !== "expr") fail("R-IN2", `calling-frame statement kind ${cs.k} where the constructor has an expression`);
        const tst = store(ts);
        const cst = store(cs);
        const tVal = tst !== null ? tst.value : (ts as Extract<Stmt, { k: "expr" }>).expr;
        const cVal = cst !== null ? cst.value : (cs as Extract<Stmt, { k: "expr" }>).expr;
        if (tst !== null && !isTemplateLocal(tst.name)) fail("R-IN1", `the constructor writes the outer name ${tst.name}`);
        if (!eq(tVal, cVal)) fail("R-IN2", "a calling-frame statement is not the constructor's");
        const shared = toks.fresh();
        if (tst !== null) toks.write(tenv, tst.name, shared);
        if (cst !== null) { if (cst.name === x) fail("R-IN2", "the receiver register is overwritten"); toks.write(env, cst.name, shared); written.add(cst.name); }
        toks.clobberSlots(env, keepSlots);
        ti++; j++;
      }
      if (env.get(x) !== OBJ) fail("R-IN2", "the receiver register does not hold the receiver at the end");
      // Section 9.2 (4): the arguments, as values the frame holds at the start.
      const start = envAt;
      const args: Expr[] = [];
      const n = Math.max(info.ctor.params.length, bound.length);
      for (let k = 0; k < n; k++) {
        const b = bound[k];
        if (b === undefined) { args.push({ k: "lit", text: "undefined" }); continue; }
        args.push(exprFor(b, start, new Set(), "R-IN4"));
      }
      while (args.length > 0 && args[args.length - 1]!.k === "lit" && (args[args.length - 1] as { text: string }).text === "undefined" && bound[args.length - 1] === undefined) args.pop();
      const out: Stmt[] = [{ k: "expr", expr: { k: "assign", target: ident(x), value: { k: "new", callee: cExpr!, args } } }];
      // Section 9.2 (5): every other register the region wrote.
      for (const w of [...written].sort()) {
        if (w === x) continue;
        if (deadAfter(w, levels.map((l, k) => (k === levels.length - 1 ? { ...l, at: j } : l)))) continue;
        const v = exprFor(env.get(w)!, env, written, "R-IN5", x);
        out.push(declaredHere.has(w) ? { k: "init", kind: "let", name: w, value: v } : { k: "expr", expr: { k: "assign", target: ident(w), value: v } });
      }
      return { end: j, stmts: out };

      function applyCaller(s: Stmt, e: Env, at: number): number {
        if (s.k === "decl") { for (const nm of s.names) { toks.write(e, nm, "lit:undefined"); written.add(nm); declaredHere.add(nm); } return at + 1; }
        const st = store(s)!;
        const t = tokOf(e, st.value) ?? undefined;
        if (st.name === x && t !== OBJ) fail("R-IN2", "the receiver register is overwritten");
        toks.write(e, st.name, t);
        written.add(st.name);
        if (st.decl) declaredHere.add(st.name);
        return at + 1;
      }
      function applyTemplate(s: Stmt): void {
        if (s.k === "decl") { for (const nm of s.names) toks.write(tenv, nm, "lit:undefined"); return; }
        const st = store(s)!;
        if (!isTemplateLocal(st.name)) fail("R-IN1", `the constructor writes the outer name ${st.name}`);
        toks.write(tenv, st.name, tokT(st.value) ?? undefined);
      }
      function isTemplateLocal(name: string): boolean { return info.ctor.params.some((p) => p.name === name) || declaredInBody(info.ctor.body).has(name); }
      function tokT(e: Expr): string | null {
        if (e.k === "ident") {
          if (tenv.has(e.name)) return tenv.get(e.name)!;
          const pi = info.ctor.params.findIndex((p) => p.name === e.name);
          if (pi !== -1) return `arg:${pi}`;
          if (declaredInBody(info.ctor.body).has(e.name)) fail("R-IN1", `the constructor reads ${e.name} before it is declared`);
          return tokOf(env, e); // a free name: the class's scope is the calling frame's (section 9.2 (2))
        }
        return tokOf(tenv, e);
      }
      function eq(te: Expr, ce: Expr): boolean {
        if (te.k === "this") return ce.k === "ident" && tokOf(env, ce) === OBJ;
        if (te.k === "ident" || te.k === "lit" || ce.k === "ident" || ce.k === "lit") {
          const tt = tokT(te);
          const tc = tokOf(env, ce);
          if (tt === null || tc === null || tc === OBJ) return false;
          if (tt.startsWith("arg:")) {
            const k = Number(tt.slice(4));
            if (bound[k] === undefined) { bound[k] = tc; return true; }
            return bound[k] === tc;
          }
          return tt === tc;
        }
        if (te.k !== ce.k) return false;
        switch (te.k) {
          case "member": {
            const c = ce as typeof te;
            if (te.computed !== c.computed || !eq(te.obj, c.obj)) return false;
            return te.computed ? eq(te.prop, c.prop) : JSON.stringify(te.prop) === JSON.stringify(c.prop);
          }
          case "call":
          case "new": {
            const c = ce as typeof te;
            return eq(te.callee, c.callee) && te.args.length === c.args.length && te.args.every((a, k) => eq(a, c.args[k]!));
          }
          case "bin":
          case "logical": {
            const c = ce as typeof te;
            return te.op === c.op && eq(te.left, c.left) && eq(te.right, c.right);
          }
          case "unary": { const c = ce as typeof te; return te.op === c.op && eq(te.arg, c.arg); }
          case "cond": { const c = ce as typeof te; return eq(te.test, c.test) && eq(te.then, c.then) && eq(te.else, c.else); }
          case "array": { const c = ce as typeof te; return te.elements.length === c.elements.length && te.elements.every((a, k) => eq(a, c.elements[k]!)); }
          case "object": {
            const c = ce as typeof te;
            return te.props.length === c.props.length && te.props.every((p, k) => {
              const q = c.props[k]! as typeof p;
              const strip = (o: object): string => JSON.stringify({ ...o, value: undefined, key: "key" in o && (o as { computed?: boolean }).computed ? undefined : (o as { key?: unknown }).key });
              if (strip(p) !== strip(q)) return false;
              const pk = p as { computed?: boolean; key?: Expr; value?: Expr };
              const qk = q as { computed?: boolean; key?: Expr; value?: Expr };
              if (pk.computed === true && !eq(pk.key!, qk.key!)) return false;
              return pk.value === undefined ? qk.value === undefined : qk.value !== undefined && eq(pk.value, qk.value);
            });
          }
          case "assign": {
            const c = ce as typeof te;
            if (te.target.k === "ident" || c.target.k === "ident") return false; // a nested register write: not tracked
            return eq(te.target, c.target) && eq(te.value, c.value);
          }
          default:
            return false; // R-IN2 via the caller: an expression kind this comparison does not model
        }
      }
    };
    return scan(frame.body, env0, []);
  };
  const after = run({ body: root, isRoot: true, declared: new Set() }, new Map());
  return { after, folded };
}

function isMemberCall(callee: Expr, obj: string, prop: string): boolean {
  return callee.k === "member" && !callee.computed && isIdent(callee.obj, obj) && callee.prop.k === "lit" && callee.prop.text === prop;
}
/** `X = Object.create(P === null ? null : typeof P === "object" ? P : Object.prototype);`
 *  (X and P the same register or not): the receiver register X, or `null`. */
function createdFrom(s: Stmt | undefined, p: string): string | null {
  const st = store(s);
  return st !== null && !st.decl && isObjectCreateOf(st.value, p) ? st.name : null;
}
function isObjectCreateOf(v: Expr, x: string): boolean {
  if (v.k !== "call" || !isMemberCall(v.callee, "Object", "create") || v.args.length !== 1) return false;
  const want: Expr = { k: "cond", test: { k: "bin", op: "===", left: ident(x), right: { k: "lit", text: "null" } } as Expr, then: { k: "lit", text: "null" }, else: { k: "cond", test: { k: "bin", op: "===", left: { k: "unary", op: "typeof ", arg: ident(x) }, right: { k: "lit", text: '"object"' } } as Expr, then: ident(x), else: { k: "member", obj: ident("Object"), prop: { k: "lit", text: "prototype" }, computed: false } } };
  return sameShape(v.args[0]!, want);
}
function sameShape(a: Expr, b: Expr): boolean {
  const norm = (e: unknown): unknown => (Array.isArray(e) ? e.map(norm) : e !== null && typeof e === "object" ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== "global" && k !== "comment").map(([k, v]) => [k, norm(v)])) : e);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}
function isSuperTwiceGuard(s: Stmt | undefined, t: string): boolean {
  if (s === undefined || s.k !== "if" || s.else.length !== 0 || s.then.length !== 1) return false;
  if (s.test.k !== "bin" || s.test.op !== "!==" || !isIdent(s.test.left, t) || !isIdent(s.test.right, "__hbc_empty")) return false;
  const th = s.then[0]!;
  return th.k === "throw" && th.arg.k === "new" && isIdent(th.arg.callee, "ReferenceError") && th.arg.args.length === 1 && th.arg.args[0]!.k === "lit" && th.arg.args[0]!.text === SUPER_TWICE;
}
/** `if (E) ...` or `A = E; if (A) ...` (either side may have stored the test). */
function condOf(list: readonly Stmt[], i: number): { readonly test: Expr; readonly node: Extract<Stmt, { k: "if" }>; readonly consumed: number; readonly assigned: string | null } | null {
  const s = list[i];
  if (s === undefined) return null;
  if (s.k === "if") return { test: s.test, node: s, consumed: 1, assigned: null };
  const st = store(s);
  const nx = list[i + 1];
  if (st !== null && nx !== undefined && nx.k === "if" && isIdent(nx.test, st.name) && !mentions(nx.then, st.name)) return { test: st.value, node: nx, consumed: 2, assigned: st.name };
  return null;
}
/** The message (a literal's text) of the TypeError a branch certainly throws
 *  through the emitter's helper, or `null`. `levels` (calling frame only)
 *  lets a `break L` stand for "fall into what follows `L: {...}`". */
function throwMessage(stmts: readonly Stmt[], env0: Env, levels: readonly Level[] | null): string | null {
  const env: Env = new Map(env0);
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]!;
    if (skippable(s)) continue;
    if (silent(s) && s.k !== "decl") { const st = store(s)!; env.set(st.name, tokOf(env, st.value) ?? "?"); continue; }
    if (s.k === "break" && s.label !== null && levels !== null && i === stmts.length - 1) {
      for (let k = levels.length - 1; k >= 0; k--) {
        const lv = levels[k]!;
        if (lv.label === s.label) return throwMessage(lv.list.slice(lv.at + 1), new Map(), null);
      }
      return null;
    }
    const st = store(s);
    const call = st !== null ? st.value : s.k === "expr" ? s.expr : null;
    if (call === null || call.k !== "call" || !isIdent(call.callee, THROW_HELPER) || call.args.length !== 1) return null;
    const t = tokOf(env, call.args[0]!);
    return t !== null && t.startsWith("lit:") ? t : null;
  }
  return null;
}
const DECLARED = new WeakMap<readonly Stmt[], Set<string>>();
function declaredInBody(body: readonly Stmt[]): Set<string> {
  let d = DECLARED.get(body);
  if (d === undefined) {
    d = new Set();
    const dd = d;
    walk(body, { stmt: (s) => { if (s.k === "init") dd.add(s.name); if (s.k === "decl") for (const n of s.names) dd.add(n); } });
    DECLARED.set(body, d);
  }
  return d;
}
function declaredIn(f: Extract<Stmt, { k: "func" }>): Set<string> {
  const d = new Set(declaredInBody(f.body));
  for (const p of f.params) d.add(p.name);
  walk(f.body, { stmt: (s) => { if (s.k === "func") d.add(s.name); } });
  return d;
}
function freeTemplateNames(ctor: Extract<Expr, { k: "func" }>): Set<string> {
  const local = new Set([...declaredInBody(ctor.body), ...ctor.params.map((p) => p.name)]);
  const out = new Set<string>();
  walk(ctor.body, { expr: (e) => { if (e.k === "ident" && !local.has(e.name)) out.add(e.name); } });
  return out;
}
/** Section 9.3 R-IN1: the constructor body may contain only what the
 *  lock-step comparison models. */
function checkTemplate(body: readonly Stmt[]): void {
  if (hasKind(body, new Set(["return", "try", "while", "do-while", "for", "for-in", "for-of", "switch", "labeled", "break", "continue", "func"]), true)) fail("R-IN1", "the constructor body has control flow or a nested function the comparison does not model");
  let bad: string | null = null;
  walk(body, { expr: (e) => { if (e.k === "func" || e.k === "class" || e.k === "argumentsObject" || e.k === "spread" || (e.k as string) === "newTarget" || (e.k === "ident" && e.name === "arguments")) bad = e.k; } });
  if (bad !== null) fail("R-IN1", `the constructor body uses ${bad}`);
}
/** An expression that, placed where the rebuilt statement sits, evaluates to
 *  the value `tok` names in `env`; refuses with `code` when there is none. */
function exprFor(tok: string, env: Env, written: ReadonlySet<string>, code: RefusalCode, receiver?: string): Expr {
  if (tok.startsWith("lit:")) return { k: "lit", text: tok.slice(4) };
  if (tok === OBJ && receiver !== undefined) return ident(receiver);
  if (tok.startsWith("id:") && !written.has(tok.slice(3)) && (env.get(tok.slice(3)) ?? tok) === tok) return ident(tok.slice(3));
  for (const [k, v] of env) if (v === tok && !written.has(k)) return ident(k);
  return fail(code, `no name holds the value ${tok} where the rebuilt statement sits`);
}
/** Section 9.2 (5): `name` is overwritten before any read on every path out
 *  of the region, or the frame ends first. Conservative: a jump refuses. */
function deadAfter(name: string, levels: readonly Level[]): boolean {
  for (let k = levels.length - 1; k >= 0; k--) {
    const { list, at } = levels[k]!;
    for (let i = k === levels.length - 1 ? at : at + 1; i < list.length; i++) {
      const s = list[i]!;
      const st = store(s);
      if (st !== null && st.name === name && !mentions([{ k: "expr", expr: st.value }], name)) return !st.decl;
      if (mentions(s, name)) return false;
      if (hasKind([s], JUMPS, false)) return false;
      if (s.k === "return" || s.k === "throw") return true;
    }
  }
  return true;
}
