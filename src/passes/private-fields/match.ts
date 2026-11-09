// private-fields matcher -- docs/specs/passes/24-class-recover.md's private-name
// follow-up, catalogue row 20 (see LOWERING-CATALOGUE.md). `src/emit/lower.ts`'s
// "private names" block lowers every private-name opcode into a *symbol*-keyed
// shape (`CreatePrivateName` -> `Symbol("#x")`, `AddOwnPrivateBySym` ->
// `Object.defineProperty(obj, sym, {value, writable:true, ...})`,
// `Get/PutOwnPrivateBySym` -> `obj[sym]`, `PrivateIsIn` ->
// `Object.prototype.hasOwnProperty.call(obj, sym)`) so the pipeline stays
// behaviour-preserving even where no later rung recognises the shape. This
// rung runs after `class-recover` has already raised the `CreateBaseClass`/
// `CreateDerivedClass` group into a `class` node (F24-1) and folds every
// symbol-keyed private-name shape it owns back into real `#name` syntax --
// field declarations, `obj.#name` reads/writes, `#name in obj` brand checks.
//
// Safety (spec 24's refusal discipline, applied to a private name instead of
// a class member): a candidate name is folded only when *every* reference to
// it anywhere in the enclosing function's tree -- including inside every
// class member's body, which `class-recover` already spliced into this same
// tree -- is one of the four recognised shapes above. Any other reference
// (the name stored into a field, passed to a call, returned, compared, ...)
// refuses that one name; the class's other private names are still tried
// independently, and refusal is silent shape-preservation, never a partial
// rewrite (PL-05: `--passes=none` is untouched either way).
//
// Register aliasing (`r3 = _e0_0;` before a use) is resolved the same way
// class-recover's own `regValues` resolves method keys: an *ordered*
// left-to-right scan (recursing into `if`/`labeled` nesting -- see
// `foldInBody`'s own doc comment), tracking which registers currently hold
// the candidate's value and forgetting one the moment it is reassigned to
// anything else -- never a position-blind "was it ever assigned this" set,
// which would (wrongly) call a register that held a *different* private name
// earlier in the same list an alias of this one too.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, identUsesMany, isHelperCall, mapStmts, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import { brandSymbolName, foldMethods, methodFns } from "./methods.ts";

export interface PrivateFieldsGroup {
  /** Display name (with the leading `#`) of every candidate this rung
   *  actually folded, in declaration order. */
  readonly folded: readonly string[];
}

type Ident = Extract<Expr, { k: "ident" }>;
type ClassExpr = Extract<Expr, { k: "class" }>;

function isIdent(e: Expr): e is Ident {
  return e.k === "ident";
}

/** `Symbol("#name")` -- the exact shape `CreatePrivateName` lowers to. Returns
 *  the raw name (`"#balance"`, `#` included) or `null`. */
function privateSymbolName(e: Expr): string | null {
  if (e.k !== "call" || e.callee.k !== "ident" || e.callee.name !== "Symbol" || e.args.length !== 1) return null;
  const a = e.args[0]!;
  if (a.k !== "lit" || a.text.length < 4 || a.text[0] !== '"' || a.text[1] !== "#" || a.text[a.text.length - 1] !== '"') return null;
  return a.text.slice(1, -1);
}

/** A statement that stores a value into a single named variable, whichever
 *  of the two shapes the emitter used (`k:"init"` the first time a name is
 *  written, `k:"expr"`+`assign` every time after). */
export function simpleStore(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && isIdent(s.expr.target)) return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

/** An env slot as the emitter spells one (`_e0_0`, `_e181_13`) -- the same
 *  shape `src/passes/super-call/match.ts`'s own `ENV_SLOT` matches. A slot is
 *  the frame's shared binding, so it is what a class member's body reads;
 *  a register is this frame's own temporary and means nothing inside one. */
export const ENV_SLOT = /^_e\d+_\d+$/;

/** One private name this rung may try to fold.
 *
 *  `envName` is the name a *member body* sees the symbol under -- the env slot
 *  when hermesc used one, the register otherwise. `regName` is the extra
 *  defining-frame register the symbol passed through on its way into that slot
 *  (`let r5 = Symbol("#x"); _e0_0 = r5;`), or `null` when the emitter stored
 *  `Symbol("#name")` straight into the slot. Both names have to be deleted,
 *  and both have to be free of surviving reads, for the fold to be safe. */
export interface PrivateFieldCandidate {
  readonly envName: string;
  readonly displayName: string;
  readonly regName: string | null;
  /** Spec 24 section 1.7.1: a private-method brand (`Symbol("Class")`), folded
   *  by `./methods.ts` through `foldOne`; its creation has no `#`. */
  readonly brand?: true;
}

/** Every top-level private-name creation in `before` -- the emitter's lowering
 *  of `CreatePrivateName` plus its `StoreToEnvironment`, in either of the two
 *  spellings hermesc produces:
 *
 *    `_e0_0 = Symbol("#x");`                  (one store; fixture 35)
 *    `let r5 = Symbol("#x"); _e0_0 = r5;`     (two; fixture 81, and the shape
 *                                              the react-navigation bundle's
 *                                              derived classes use)
 *
 *  The second appears whenever hermesc keeps the symbol in a register for a
 *  moment (register pressure around a derived class's own construction), and
 *  it is the reason a candidate carries a *slot* name rather than whatever
 *  name the `Symbol(...)` call was first stored under: the class's members can
 *  only ever read the slot. Exactly ONE register hop is followed, and only
 *  into an env slot -- the same one-hop rule `derefChain` states in
 *  `src/passes/super-call/match.ts` ("the emitter never chains more than one
 *  move per operand in this shape, and a longer chain is a shape this rung has
 *  not measured"). The hop is dropped the moment the register is written
 *  again before the slot store, so a register that held a *different* value by
 *  then is never followed (the position-blind mistake this file's header
 *  comment already warns about, in its store-scanning half). */
export function findCandidates(before: readonly Stmt[], pick: (e: Expr) => string | null = privateSymbolName): readonly PrivateFieldCandidate[] {
  const out: { envName: string; displayName: string; regName: string | null }[] = [];
  // Register -> the candidate it currently holds, live only while nothing has
  // overwritten it and it has not already been followed into a slot.
  const inRegister = new Map<string, { envName: string; displayName: string; regName: string | null }>();
  for (const s of before) {
    const store = simpleStore(s);
    if (store === null) continue;
    const displayName = pick(store.value);
    if (displayName !== null) {
      const c = { envName: store.name, displayName, regName: null };
      out.push(c);
      if (!ENV_SLOT.test(store.name)) inRegister.set(store.name, c);
      continue;
    }
    inRegister.delete(store.name); // this register now holds something else
    if (!ENV_SLOT.test(store.name) || !isIdent(store.value)) continue;
    const src = inRegister.get(store.value.name);
    if (src === undefined) continue;
    src.regName = src.envName;
    src.envName = store.name;
    inRegister.delete(store.value.name); // one hop only
  }
  return out;
}

/** The one recovered `class` node in `before`, class-recover's own head
 *  shape (an assignment or `let`-init whose value is `k:"class"`) -- found
 *  generically so this rung does not need to re-derive class-recover's own
 *  group. `null` when there is none, or more than one (ambiguous). */
export function findClass(before: readonly Stmt[]): ClassExpr | null {
  const found: ClassExpr[] = [];
  walk(before, { expr: (e) => { if (e.k === "class") found.push(e); } });
  return found.length === 1 ? found[0]! : null;
}

export function ctorBody(cls: ClassExpr): readonly Stmt[] | null {
  const m = cls.members.find((m) => m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor");
  return m !== undefined && m.value !== null && m.value.k === "func" ? m.value.body : null;
}

/** `Object.<name>(...)`, the emitter's own spelling (non-computed member on
 *  a bare `Object` ident). */
function objectCall(e: Expr, name: string): readonly Expr[] | null {
  if (e.k !== "call" || e.callee.k !== "member" || e.callee.computed) return null;
  if (e.callee.obj.k !== "ident" || e.callee.obj.name !== "Object") return null;
  const p = e.callee.prop;
  return p.k === "lit" && p.text === name ? e.args : null;
}

/** `Object.prototype.hasOwnProperty.call(obj, key)` -- `hasOwn()` in
 *  `src/emit/lower.ts`, `PrivateIsIn`'s lowering. */
export function hasOwnCall(e: Expr): readonly Expr[] | null {
  if (e.k !== "call" || e.callee.k !== "member" || e.callee.computed || e.callee.prop.k !== "lit" || e.callee.prop.text !== "call") return null;
  const target = e.callee.obj;
  if (target.k !== "member" || target.computed || target.prop.k !== "lit" || target.prop.text !== "hasOwnProperty") return null;
  const proto = target.obj;
  if (proto.k !== "member" || proto.computed || proto.prop.k !== "lit" || proto.prop.text !== "prototype") return null;
  return proto.obj.k === "ident" && proto.obj.name === "Object" && e.args.length === 2 ? e.args : null;
}

/** `AddOwnPrivateBySym`'s exact descriptor (`defineProperty()` in
 *  `src/emit/lower.ts`): `{value, writable:true, enumerable:false,
 *  configurable:false}`, in that order, nothing else -- an ordinary
 *  (non-private) instance install never has this exact shape (a class
 *  member's descriptor is `enumerable:false, configurable:true`, spec 24
 *  section 3.1's `readDescriptor`). */
function isTrue(e: Expr): boolean {
  return e.k === "lit" && e.text === "true";
}
function isFalse(e: Expr): boolean {
  return e.k === "lit" && e.text === "false";
}
function privateInstallValue(args: readonly Expr[]): Expr | null {
  if (args.length !== 3) return null;
  const desc = args[2]!;
  if (desc.k !== "object" || desc.props.length !== 4) return null;
  const props = desc.props;
  if (props.some((p) => "k" in p)) return null;
  const named = props as readonly { readonly key: string; readonly computed: boolean; readonly value: Expr }[];
  if (named.some((p) => p.computed)) return null;
  const byKey = new Map(named.map((p) => [p.key, p.value] as const));
  if (byKey.size !== 4) return null;
  const value = byKey.get("value");
  if (value === undefined || !isTrue(byKey.get("writable")!) || !isFalse(byKey.get("enumerable")!) || !isFalse(byKey.get("configurable")!)) return null;
  return value;
}

interface FoldOutcome {
  readonly body: readonly Stmt[];
  readonly initExpr: Expr | null;
}

/** Folds one candidate's uses inside a *single* member body: `allowInstall`
 *  is true only for the constructor, the one place `AddOwnPrivateBySym`
 *  (the field's declare-and-initialise) can appear. Returns `null` on any
 *  reference this rung does not recognise -- the escape refusal.
 *
 *  The scan is sequential and *recurses* into `if`/`labeled` nesting (a
 *  `labeled` block is straight-line code with a `break` target, not a
 *  branch, so its aliases flow back out; an `if`'s two arms are forked
 *  independently from the same entry state and neither's own updates
 *  leaks to what follows -- withdraw's guard clause reassigns its `r0` to
 *  `globalThis` on the throwing arm only, and the surviving `r0` after the
 *  `if` is still this candidate's alias). Anything this rung has no
 *  fixture shape for yet (`while`/`for`/`switch`/`try`) is scanned as one
 *  leaf with the entry alias set, same as a single statement -- correct as
 *  long as no register is repurposed *inside* it, which no committed
 *  fixture does; a future one that does would need this recursion
 *  extended to match, not a silent wrong rewrite, because the escape scan
 *  below still runs over its full (unrecursed) subtree and refuses any
 *  reference it cannot place. */
export function foldInBody(body: readonly Stmt[], envName: string, displayName: string, allowInstall: boolean): FoldOutcome | null {
  // A `lit` node, not an `ident`: `member`'s non-computed printer reads
  // `.text` off whatever `prop` is regardless of its `k` (`src/emit/print.ts`),
  // and `walk`'s "member" case visits `prop` unconditionally, so an `ident`
  // here would both print wrong (no `.text`) and read as a captured free
  // variable named `#balance` to `freeNames` -- neither problem exists for a
  // bare `lit` (`classMemberKey` and `render` both print a `lit`'s `.text`
  // as-is, and only `ident` nodes count as a use in `freeNames`).
  const displayKey = (): Expr => ({ k: "lit", text: displayName });
  let initExpr: Expr | null = null;
  let installs = 0;
  let escaped = false;
  const droppedInits: string[] = [];

  // General register-value resolution (class-recover's own `regValues`
  // technique) for the install's `value` argument, which is a bare register
  // reference (`Object.defineProperty(r1, r3, {value: r0, ...})`), not the
  // literal initialiser -- resolved the same way, forked the same way.
  const resolve = (regs: ReadonlyMap<string, Expr>, e: Expr): Expr => (isIdent(e) ? (regs.get(e.name) ?? e) : e);
  // A `AddOwnPrivateBySym`/`Object.defineProperty` install is only safe to
  // fold into a real class-field declaration when its target resolves to
  // the literal `this` -- native private fields can only ever be added to
  // an object during ITS OWN class's [[Construct]] (auto-initialised on
  // `this` before the constructor body runs, or by `this.#x = v` field
  // syntax executed while `this` is bound to that exact object). Several of
  // this codebase's decompiled base-class constructors instead build a
  // *separate* plain object (`let r1 = Object.create(new.target.prototype);
  // ...; return r1;`) and explicitly return it, discarding the real `this`
  // -- a completely valid, common Hermes lowering (support for
  // `Reflect.construct`/`new.target` polymorphism), but one where `r1`
  // never receives the class's private-field brand at all. Folding
  // `Object.defineProperty(r1, sym, {...})` into `#x;` there is a silent
  // behaviour change: `r1.#x = v` throws `TypeError: Cannot write private
  // member #x to an object whose class did not declare it` (found by the
  // T2 equivalence gate, tests/gate/decompile/equivalence.test.ts,
  // fixture 35 -- traces diverge at record 0, the `new BankAccount(...)`
  // call itself). `Object.defineProperty` with a `Symbol` key has no such
  // restriction (it writes to whatever object it is given), which is
  // exactly why that shape is the correct, safe fallback and this rung
  // must refuse rather than "fix" it.
  //
  // Fixing it is a *different* rung's job, and it is now done upstream:
  // `ctor-this` (docs/specs/passes/26-ctor-this.md, R12) proves that in a
  // BASE class that stand-in IS the object `[[Construct]]` bound to `this`
  // and substitutes the literal `this` before this rung ever runs. So this
  // guard is unchanged and still exactly as strict; its input changed, and
  // fixture 35 folds.
  const isThisArg = (e: Expr, regs: ReadonlyMap<string, Expr>): boolean => resolve(regs, e).k === "this";
  const regSources = new Map<string, Stmt>();
  const claimedSources = new Set<Stmt>();
  const resolveClaim = (regs: ReadonlyMap<string, Expr>, e: Expr): Expr => {
    if (isIdent(e) && regs.has(e.name)) {
      const src = regSources.get(e.name);
      // Only claim (and so delete) the source statement when this register
      // has exactly one use in the whole body -- the constructor's "BankAccount"
      // brand install and a real field's install can share one `let rN =
      // undefined;` temporary (hermesc reuses a register across sibling
      // `AddOwnPrivateBySym` calls with the same literal value), and deleting
      // a still-shared declaration would leave the other install reading an
      // undeclared name.
      if (src !== undefined) {
        let uses = 0;
        walk(body, { expr: (n) => { if (isIdent(n) && n.name === e.name) uses++; } });
        if (uses === 1) claimedSources.add(src);
      }
      return regs.get(e.name)!;
    }
    return e;
  };

  /** Scans and rewrites one expression subtree in place (an `if`'s test, or
   *  the whole of any other statement's own expressions via `mapExpr`). Marks
   *  every recognised-shape key as consumed, flags an escape for any other
   *  reference to a live alias, and returns the rewritten node. */
  function processExpr(e: Expr, aliases: ReadonlySet<string>, regs: ReadonlyMap<string, Expr>, assignTarget: Expr | null): Expr {
    const consumed = new Set<Expr>();
    walk([{ k: "expr", expr: e }], {
      expr: (n) => {
        if (n.k === "member" && n.computed && isIdent(n.prop) && aliases.has(n.prop.name)) {
          consumed.add(n.prop);
          return;
        }
        const hasOwnArgs = hasOwnCall(n);
        if (hasOwnArgs !== null && isIdent(hasOwnArgs[1]!) && aliases.has((hasOwnArgs[1] as Ident).name)) {
          // A brand test on `this` in the constructor ahead of the install
          // (and not the double-init guard `fold` drops with it) would read
          // `#x in this` after the field declaration already added the field:
          // a different answer. Refuse the name.
          if (allowInstall && installs === 0 && isThisArg(hasOwnArgs[0]!, regs)) escaped = true;
          consumed.add(hasOwnArgs[1]!);
          return;
        }
        if (allowInstall) {
          const defineArgs = objectCall(n, "defineProperty");
          if (defineArgs !== null && defineArgs.length === 3 && isIdent(defineArgs[1]!) && aliases.has((defineArgs[1] as Ident).name) && isThisArg(defineArgs[0]!, regs)) {
            const value = privateInstallValue(defineArgs);
            if (value !== null) {
              consumed.add(defineArgs[1]!);
              initExpr = resolveClaim(regs, value);
              installs++;
            }
          }
        }
      },
    });
    walk([{ k: "expr", expr: e }], {
      expr: (n) => {
        if (!isIdent(n) || !aliases.has(n.name) || consumed.has(n)) return;
        if (n === assignTarget) return; // a plain reassignment target (case b)
        escaped = true;
      },
    });
    const fx = (n: Expr): Expr => {
      if (n.k === "member" && n.computed && isIdent(n.prop) && aliases.has(n.prop.name)) return { ...n, prop: displayKey(), computed: false };
      const hasOwnArgs = hasOwnCall(n);
      if (hasOwnArgs !== null && isIdent(hasOwnArgs[1]!) && aliases.has((hasOwnArgs[1] as Ident).name)) return { k: "bin", op: "in", left: displayKey(), right: hasOwnArgs[0]! };
      return n;
    };
    return mapExprFully(e, fx);
  }

  function mapExprFully(e: Expr, fx: (e: Expr) => Expr): Expr {
    const wrapped = mapStmts([{ k: "expr", expr: e }], (s) => s, fx)[0] as Extract<Stmt, { k: "expr" }>;
    return wrapped.expr;
  }

  /** Advances the alias/register state one plain statement's worth, without
   *  descending into `if`/`labeled` (the caller, `fold`, handles those). */
  function step(s: Stmt, aliases: ReadonlySet<string>, regs: ReadonlyMap<string, Expr>): { readonly stmt: Stmt | null; readonly aliasesOut: ReadonlySet<string>; readonly regsOut: ReadonlyMap<string, Expr> } {
    const store = simpleStore(s);

    // (a) A pure copy of a live alias into a fresh register: extend the
    // alias set and drop the statement (see the doc comment above).
    if (store !== null && isIdent(store.value) && aliases.has(store.value.name)) {
      // The dropped statement may be the register's *declaration* (`let r0 =
      // _e0_0;`, the `k:"init"` spelling) while a later statement in the same
      // body repurposes the same register for something else (`withdraw`'s
      // `r0 = globalThis;` on fixture 35's throwing arm). Dropping the
      // declaration with the statement leaves that assignment undeclared,
      // which in a class body -- always strict -- is a ReferenceError at run
      // time. Remembered here and re-declared once, as a bare `let`, in front
      // of the folded body, but only if a reference really does survive the
      // fold (see `redeclare` below). Found when `ctor-this` first let this
      // rung fire on a real fixture.
      if (s.k === "init") droppedInits.push(s.name);
      return { stmt: null, aliasesOut: new Set(aliases).add(store.name), regsOut: regs };
    }
    let nextAliases = aliases;
    let nextRegs = regs;
    if (store !== null) {
      if (aliases.has(store.name)) nextAliases = new Set([...aliases].filter((n) => n !== store.name)); // (b) repurposed
      // Recorded so an install that consumes this register's value can
      // claim (delete) the statement that produced it, rather than
      // duplicating a possibly-impure expression (`new Array(0)`) into the
      // field initialiser *and* leaving the original store behind dead.
      // Only the constructor ever has an install to claim into, and a
      // constructor writes each of its own temporaries once before moving
      // on to the next field (`AddOwnPrivateBySym`'s own bytecode shape,
      // one per field) -- a register this rung tracks here is never read
      // again after the claim, in every fixture shape this rung sees.
      nextRegs = new Map(regs).set(store.name, resolve(regs, store.value));
      regSources.set(store.name, s);
    }

    const assignTarget = s.k === "expr" && s.expr.k === "assign" && store !== null ? s.expr.target : null;
    if (s.k === "expr") {
      if (allowInstall) {
        const defineArgs = objectCall(s.expr, "defineProperty");
        if (defineArgs !== null && defineArgs.length === 3 && isIdent(defineArgs[1]!) && aliases.has((defineArgs[1] as Ident).name) && isThisArg(defineArgs[0]!, regs) && privateInstallValue(defineArgs) !== null) {
          processExpr(s.expr, aliases, regs, assignTarget); // records initExpr/installs, consumes the key
          return { stmt: null, aliasesOut: nextAliases, regsOut: nextRegs };
        }
      }
      const expr = processExpr(s.expr, aliases, regs, assignTarget);
      return { stmt: expr === s.expr ? s : { ...s, expr }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    if (s.k === "init") {
      const value = processExpr(s.value, aliases, regs, null);
      return { stmt: value === s.value ? s : { ...s, value }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    if (s.k === "return") {
      const arg = s.arg === null ? null : processExpr(s.arg, aliases, regs, null);
      return { stmt: arg === s.arg ? s : { ...s, arg }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    if (s.k === "throw") {
      const arg = processExpr(s.arg, aliases, regs, null);
      return { stmt: arg === s.arg ? s : { ...s, arg }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    // A function DECLARED in this body (spec 24 section 1.7, "nested
    // functions"): it is lexically inside the class, so `#name` is in scope
    // there, and it is a separate Hermes frame with its own registers -- the
    // only way it can see this body's aliases is through an env slot, so it
    // is folded as its own body starting from the symbol's slot alone, and
    // refuses the name when it names any other live alias (a slot copy this
    // fold would delete) or contains an install. `sameFrame` closures are
    // expressions, never statements; refused anyway for safety.
    if (s.k === "func" && identUses(s.body, envName).reads + identUses(s.body, envName).writes + identUses(s.body, envName).nested > 0) {
      const others = [...aliases].filter((n) => n !== envName);
      if ((s as { sameFrame?: true }).sameFrame === true || others.some((n) => { const u = identUses(s.body, n); return u.reads + u.writes + u.nested > 0; })) {
        escaped = true;
        return { stmt: s, aliasesOut: nextAliases, regsOut: nextRegs };
      }
      const inner = foldInBody(s.body, envName, displayName, false);
      if (inner === null) {
        escaped = true;
        return { stmt: s, aliasesOut: nextAliases, regsOut: nextRegs };
      }
      return { stmt: inner.body === s.body ? s : { ...s, body: inner.body }, aliasesOut: nextAliases, regsOut: nextRegs };
    }
    // Anything else this fixture's shapes never produce here (`decl`,
    // `break`/`continue`, a nested `func`, ...): no expression of its own to
    // scan (a `func`'s own body is a separate frame, out of reach of a
    // register name in any case).
    return { stmt: s, aliasesOut: nextAliases, regsOut: nextRegs };
  }

  function fold(stmts: readonly Stmt[], aliasesIn: ReadonlySet<string>, regsIn: ReadonlyMap<string, Expr>): { readonly stmts: readonly Stmt[]; readonly aliasesOut: ReadonlySet<string>; readonly regsOut: ReadonlyMap<string, Expr> } {
    let aliases = aliasesIn;
    let regs = regsIn;
    const out: Stmt[] = [];
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]!;
      // hermesc's own double-initialisation guard in front of a field's
      // install (`if (hasOwnProperty.call(this, sym)) throwTypeError("Cannot
      // initialize private field twice.")`, the bytecode's `PrivateIsIn` +
      // throw before `AddOwnPrivateBySym`). Once the install becomes a real
      // field declaration, that declaration's own PrivateFieldAdd performs
      // exactly this check natively (ES2024 7.3.31: a TypeError when the
      // object already has the private name), so the guard is part of the
      // install and goes with it -- left behind it would read `#x in this`
      // AFTER the field already exists and always throw (fixtures 90, 94).
      // Only when the install it guards follows (`guardsNextInstall`).
      if (allowInstall && s.k === "if" && !isIdent(s.test) && isDoubleInitGuard(s, undefined, aliases, regs) && guardsNextInstall(stmts, i + 1, aliases, regs)) continue;
      // The v98 spelling: `rT = hasOwnProperty.call(this, sym); if (rT) {...}`.
      // The store goes with the guard, but only when `rT` is dead after it
      // (its first later mention is a plain overwrite, or there is none), so
      // nothing can observe that the brand test no longer ran.
      const next = stmts[i + 1];
      if (allowInstall && next !== undefined && next.k === "if" && isIdent(next.test) && isDoubleInitGuard(next, s, aliases, regs) && guardsNextInstall(stmts, i + 2, aliases, regs) && deadAfter(stmts, i + 2, next.test.name)) {
        if (s.k === "init") droppedInits.push(s.name); // re-declared if still used (`redeclare`)
        i++;
        continue;
      }
      if (s.k === "labeled") {
        const inner = fold(s.body, aliases, regs);
        aliases = inner.aliasesOut;
        regs = inner.regsOut;
        out.push({ ...s, body: inner.stmts });
        continue;
      }
      // A loop (spec 24 section 1.7, "loops"). Its body runs with the aliases
      // that hold on EVERY entry to it: the first one (the aliases here) and
      // every back edge. Rather than iterate to a fixed point, two
      // conservative rules make the entry set exact. (i) An alias held here
      // that the loop writes anywhere refuses the name: on a later iteration
      // the register may hold the other value. (ii) Every copy of an alias the
      // loop makes is confined (`confined` below, checked at the copy): the
      // copy is killed by a plain store in the same straight-line stretch,
      // with no jump in between, so no copy's value reaches the back edge,
      // a `continue`, a `break` or the code after the loop. So every
      // iteration starts with exactly the aliases held here, and they are
      // also what holds after the loop.
      if (s.k === "while" || s.k === "do-while" || s.k === "for") {
        if (bodyHasTry || [...aliases].some((n) => identUses([s], n).writes > 0) || (s.k === "for" && s.init !== null)) { escaped = true; out.push(s); continue; }
        // Register values (`list = this`) the loop rewrites hold only on the
        // first iteration; an install inside a loop runs zero or many times,
        // never once like a field declaration, so it refuses the name.
        const loopRegs = new Map([...regs].filter(([n]) => identUses([s], n).writes === 0));
        const installsBefore = installs;
        loopDepth++;
        const inner = fold(s.body, aliases, loopRegs);
        loopDepth--;
        if (installs !== installsBefore) escaped = true;
        const test = s.test === undefined ? undefined : processExpr(s.test, aliases, loopRegs, null);
        const update = s.k === "for" && s.update !== null ? processExpr(s.update, aliases, loopRegs, null) : null;
        if (s.k === "for") out.push({ ...s, test: test!, update, body: inner.stmts });
        else if (s.k === "do-while") out.push({ ...s, test: test!, body: inner.stmts });
        else out.push(test === undefined ? { ...s, body: inner.stmts } : { ...s, test, body: inner.stmts });
        // Registers the loop wrote no longer hold what `regs` says.
        regs = loopRegs;
        continue;
      }
      if (loopDepth > 0) {
        const cp = simpleStore(s);
        if (cp !== null && isIdent(cp.value) && aliases.has(cp.value.name) && !confined(stmts, i, cp.name)) { escaped = true; out.push(s); continue; }
      }
      if (s.k === "if") {
        const test = processExpr(s.test, aliases, regs, null);
        const thenOut = fold(s.then, aliases, regs);
        const elseOut = fold(s.else, aliases, regs);
        out.push(test === s.test && thenOut.stmts === s.then && elseOut.stmts === s.else ? s : { ...s, test, then: thenOut.stmts, else: elseOut.stmts });
        continue; // branches fork; neither's aliasing survives the `if`
      }
      const { stmt, aliasesOut, regsOut } = step(s, aliases, regs);
      aliases = aliasesOut;
      regs = regsOut;
      if (stmt !== null) out.push(stmt);
    }
    return { stmts: out, aliasesOut: aliases, regsOut: regs };
  }

  /** `if (<brand test>) { <throw the double-init TypeError> }`. The test is
   *  `hasOwnProperty.call(this, <alias>)` directly or (v98, derived bodies)
   *  a register the immediately preceding store set to exactly that; the
   *  then-arm only stores literals into registers, calls the emitter's
   *  TypeError helper with "Cannot initialize private field twice." (directly
   *  or through one of those registers) and throws. */
  function isDoubleInitGuard(s: Stmt, prev: Stmt | undefined, aliases: ReadonlySet<string>, regs: ReadonlyMap<string, Expr>): boolean {
    if (s.k !== "if" || s.else.length !== 0 || s.then.length === 0) return false;
    let test: Expr = s.test;
    if (isIdent(test)) {
      const store = prev === undefined ? null : simpleStore(prev);
      if (store === null || store.name !== test.name) return false;
      test = store.value;
    }
    const args = hasOwnCall(test);
    if (args === null || !isIdent(args[1]!) || !aliases.has(args[1].name) || !isThisArg(args[0]!, regs)) return false;
    const MSG = '"Cannot initialize private field twice."';
    const lits = new Map<string, string>();
    let helperWithMsg = false;
    const helperOk = (e: Expr): boolean => {
      if (!isHelperCall(e, "__hbc_b_throwTypeError") || e.args.length !== 1) return false;
      const m = e.args[0]!;
      if ((m.k === "lit" && m.text === MSG) || (isIdent(m) && lits.get(m.name) === MSG)) helperWithMsg = true;
      return true;
    };
    for (const t of s.then) {
      if (t.k === "throw") continue;
      if (t.k === "expr" && helperOk(t.expr)) continue;
      const store = simpleStore(t);
      if (store === null || !/^r\d+$/.test(store.name) || aliases.has(store.name)) return false;
      if (store.value.k === "lit") lits.set(store.name, store.value.text);
      else if (!helperOk(store.value)) return false;
    }
    return helperWithMsg && s.then[s.then.length - 1]!.k === "throw";
  }
  /** `reg`'s first mention in `stmts[from..]` is a plain overwrite that does
   *  not read it (or there is none): the value before `from` is dead. */
  function deadAfter(stmts: readonly Stmt[], from: number, reg: string): boolean {
    for (let j = from; j < stmts.length; j++) {
      const u = identUses([stmts[j]!], reg);
      if (u.reads + u.writes + u.nested === 0) continue;
      const store = simpleStore(stmts[j]!);
      return store !== null && store.name === reg && u.reads === 0;
    }
    return true;
  }
  /** The guarded install follows, past nothing but silent stores (an
   *  identifier or literal copied into a register that is not an alias: no
   *  user code runs, so the native check at the field's declaration and the
   *  guard observe the same object state). */
  function guardsNextInstall(stmts: readonly Stmt[], from: number, aliases: ReadonlySet<string>, regs: ReadonlyMap<string, Expr>): boolean {
    for (let j = from; j < stmts.length; j++) {
      const t = stmts[j]!;
      if (t.k === "decl") continue;
      if (t.k === "expr") {
        const defineArgs = objectCall(t.expr, "defineProperty");
        if (defineArgs !== null && defineArgs.length === 3 && isIdent(defineArgs[1]!) && aliases.has(defineArgs[1].name) && isThisArg(defineArgs[0]!, regs) && privateInstallValue(defineArgs) !== null) return true;
      }
      const store = simpleStore(t);
      if (store === null || aliases.has(store.name) || !(isIdent(store.value) || store.value.k === "lit")) return false;
    }
    return false;
  }

  /** Rule (ii) above: the copy into `reg` at `stmts[at]` is overwritten by a
   *  plain store later in the same list, and everything in between is a plain
   *  statement (no `if`, loop, label or jump, which could leave the stretch
   *  with the symbol still in `reg`). The kill may read `reg` (`r = this[r]`):
   *  its operand is evaluated, as an alias read, before the write. */
  function confined(stmts: readonly Stmt[], at: number, reg: string): boolean {
    for (let j = at + 1; j < stmts.length; j++) {
      const t = stmts[j]!;
      if (t.k !== "expr" && t.k !== "init" && t.k !== "decl" && t.k !== "comment") return false;
      const st = simpleStore(t);
      if (st !== null && st.name === reg) return true;
      if (identUses([t], reg).writes > 0) return false; // a nested write: not a plain kill
    }
    return false;
  }

  let loopDepth = 0;
  // A `catch` in this frame could observe a register an exception leaves
  // mid-stretch; loops are only reasoned about without one.
  const bodyHasTry = (() => { let t = false; walk(body, { stmt: (x) => { if (x.k === "try") t = true; } }); return t; })();
  const result = fold(body, new Set([envName]), new Map());
  if (escaped || installs > 1) return null;
  const folded = claimedSources.size === 0 ? result.stmts : result.stmts.filter((s) => !claimedSources.has(s));
  const finalBody = redeclare(folded, droppedInits);
  return { body: finalBody, initExpr };
}

/** Re-declare every name whose `k:"init"` declaration this fold dropped and
 *  which some surviving statement still reads or writes. One `let` prologue,
 *  placed after any leading directive/comment (a `"use strict"` directive
 *  must stay first) -- the same shape and position the emitter's own register
 *  prologue uses, so `pruneRegisterDecls`/`hoistRegisterInits` can still
 *  recognise it. */
function redeclare(body: readonly Stmt[], droppedInits: readonly string[]): readonly Stmt[] {
  const names = [...new Set(droppedInits)].filter((n) => {
    const u = identUses(body, n);
    return u.reads + u.writes > 0;
  });
  if (names.length === 0) return body;
  let at = 0;
  while (at < body.length && (body[at]!.k === "comment" || body[at]!.k === "directive")) at++;
  return [...body.slice(0, at), { k: "decl", kind: "let", names }, ...body.slice(at)];
}

/** Folds one candidate across the whole function tree: the constructor (the
 *  only place an install may occur) and every other member's body. Returns
 *  the new tree, or `null` (refuse this one name; `before` is untouched).
 *  Exported for `tools/passes/private-fields-refusals.ts`, which needs the
 *  final arbiter (R-PF1 below) to classify a refusal honestly. */
export function foldOne(before: readonly Stmt[], candidate: PrivateFieldCandidate, scope?: FoldScope): readonly Stmt[] | null {
  const { envName, displayName, regName } = candidate;
  const cls = findClass(before);
  if (cls === null) return null;
  const ctor = ctorBody(cls);
  if (ctor === null) return null;

  const ctorOut = foldInBody(ctor, envName, displayName, true);
  if (ctorOut === null || ctorOut.initExpr === null) return null;

  let ok = true;
  const newMembers = cls.members.map((m) => {
    if (m.value === null || m.value.k !== "func") return m;
    const isCtor = m.kind === "method" && !m.static && m.key.k === "ident" && m.key.name === "constructor";
    if (isCtor) return { ...m, value: { ...m.value, body: ctorOut.body } };
    const out = foldInBody(m.value.body, envName, displayName, false);
    if (out === null) {
      ok = false;
      return m;
    }
    return { ...m, value: { ...m.value, body: out.body } };
  });
  if (!ok) return null;

  const field = { kind: "field" as const, static: false, computed: false, key: { k: "lit" as const, text: displayName }, value: ctorOut.initExpr.k === "ident" && ctorOut.initExpr.name === "undefined" ? null : ctorOut.initExpr };
  const newCls: ClassExpr = { ...cls, members: [field, ...newMembers] };

  const fx = (e: Expr): Expr => (e === cls ? newCls : e);
  // The creation store (`<createdIn> = Symbol("#x")`) and, when the symbol
  // reached its env slot through one register hop, that hop's own store
  // (`<envName> = <regName>`) both become dead once the field is a real
  // declaration.
  const createdIn = regName ?? envName;
  const isCreation = (st: Stmt): boolean => {
    const store = simpleStore(st);
    return store !== null && store.name === createdIn && (candidate.brand === true ? brandSymbolName(store.value) : privateSymbolName(store.value)) !== null;
  };
  const isHop = (st: Stmt): boolean => {
    const store = simpleStore(st);
    return regName !== null && store !== null && store.name === envName && isIdent(store.value) && store.value.name === regName;
  };

  // R-PF1 (defining-frame escape), checked on `before` BEFORE anything is
  // deleted. Every reference to this private name inside the class is about
  // to become `#name` syntax and the symbol's own creation is about to be
  // deleted -- so a surviving READ of the symbol VALUE in the defining frame
  // is a reference this rung has no shape for and must not strand. It is not
  // merely a dangling name: a native `#name` field only exists on objects
  // branded during their own `[[Construct]]`, and the shape that leaves such a
  // read here is hermesc INLINING a construction of this very class into the
  // defining frame (`r4 = Reflect.construct(Object.getPrototypeOf(B), [...],
  // B); Object.defineProperty(r4, r5, {...});`) that inline-new could not
  // rebuild -- an object that never runs the real constructor, so folding the
  // class's accessors to `this.#x` while that copy keeps the symbol-keyed
  // install makes `r4.x` throw where the unfolded shape does not. That is the
  // same hazard `isThisArg` above refuses inside the constructor, one frame
  // out; fixtures 81 and 95 are exactly it.
  //
  // What counts as such a read (spec 24 section 1.7, "R-PF1 is def-use"):
  // * The env SLOT: any surviving mention at all, nested closures included. A
  //   slot is a frame-shared binding a closure may read at any time, so no
  //   intra-frame ordering argument covers it; and hermesc gives every binding
  //   its own slot, so a slot is never recycled for an unrelated value anyway.
  // * The REGISTER: only a read the symbol's own store still reaches
  //   (`registerReadReached`). A register is this frame's private temporary --
  //   no closure can name it -- and hermesc recycles it freely once the symbol
  //   is dead, so after inline-new has rebuilt the inlined construction that
  //   last read it, the register's later writes and reads are unrelated values
  //   (fixtures 90, 94). Those keep the register, and its declaration.
  const slotNames = [envName, createdIn].filter((n) => ENV_SLOT.test(n));
  if (!ENV_SLOT.test(createdIn) && registerReadReached(before, createdIn, isCreation, isHop, scope)) return null;

  const recycled = (() => {
    const u = identUses(before, createdIn);
    return u.reads + u.writes > (regName !== null ? 2 : 1);
  })();
  const withoutDecl = before.flatMap((st): Stmt[] => {
    if (isHop(st)) return [];
    if (!isCreation(st)) return [st];
    // A `let rN = Symbol(...)` whose register the frame recycles keeps its
    // declaration; the value it held is gone with the field declaration.
    return st.k === "init" && recycled ? [{ k: "decl", kind: st.kind, names: [createdIn] }] : [];
  });
  const mapped = mapStmts(withoutDecl, (st) => st, fx);
  const surviving = identUsesMany(mapped, [envName, createdIn]);
  for (const n of slotNames) {
    const u = surviving.get(n)!;
    if (u.reads + u.writes + u.nested > 0) return null;
  }
  // Names nothing mentions any more lose their `let`; a recycled register
  // (still written and read, as unrelated values) keeps it.
  const dead = new Set([envName, createdIn].filter((n) => {
    const u = surviving.get(n)!;
    return u.reads + u.writes + u.nested === 0;
  }));
  return mapped.map((st) => (st.k === "decl" ? { ...st, names: st.names.filter((n) => !dead.has(n)) } : st)).filter((st) => !(st.k === "decl" && st.names.length === 0));
}

/** Does any read of `reg` in the defining frame observe the value the
 *  candidate's creation store put there (`isCreation`), other than the one
 *  hop into the env slot (`isHop`)? Conservative def-use over the frame's
 *  top-level list, which is straight-line: a statement at a later index runs
 *  only after every earlier one has completed (no loop or jump at that level;
 *  a `break` out of a labelled block only moves forward), so a top-level
 *  plain store `reg = e` whose `e` does not read `reg` kills the symbol for
 *  every later statement. Anything else that mentions `reg` between the
 *  creation and that kill -- a read, or a write inside a nested `if`/loop that
 *  only kills on some paths -- counts as reached (`true`). A mention BEFORE
 *  the creation counts too, because the list may be a loop body re-entered
 *  with the symbol still in the register; and when `before` is not the whole
 *  function body, any mention of `reg` outside it does, because the register
 *  is frame-wide. Registers never appear inside a nested function (a closure
 *  reads the frame through env slots only; `identUses` never credits one). */
export function registerReadReached(before: readonly Stmt[], reg: string, isCreation: (s: Stmt) => boolean, isHop: (s: Stmt) => boolean, scope: FoldScope | undefined): boolean {
  const at = before.findIndex(isCreation);
  if (at < 0) return true;
  const mentions = (s: Stmt): boolean => {
    const u = identUses([s], reg);
    return u.reads + u.writes + u.nested > 0;
  };
  // The list is the body of a labelled block sitting directly in the
  // function body (class-recover F1): that block runs once per call, so the
  // statements before it run before the creation and cannot observe it, and
  // every exit of the block (its end, a `break` out of it) continues with the
  // statements after it -- which must kill `reg` before reading it, by the
  // same top-level rule as below (spec 24 section 1.7).
  const host = scope?.fnBody !== undefined && scope.list !== undefined && scope.fnBody !== scope.list
    ? scope.fnBody.findIndex((s) => s.k === "labeled" && s.body === scope.list) : -1;
  // A mention BEFORE the creation can only observe it if the list is
  // re-entered after the creation ran (a loop body). The function body itself,
  // and a labelled block directly in it, run once per call: their earlier
  // statements have completed before the creation, so they are not reached.
  const runsOnce = scope?.fnBody === undefined || scope.list === undefined || scope.fnBody === scope.list || host >= 0;
  if (!runsOnce) for (let i = 0; i < at; i++) if (before[i]!.k !== "decl" && mentions(before[i]!)) return true;
  if (host >= 0) {
    const fb = scope!.fnBody!;
    let killed = false;
    for (let i = host + 1; i < fb.length && !killed; i++) {
      if (!mentions(fb[i]!)) continue;
      const store = simpleStore(fb[i]!);
      if (store !== null && store.name === reg && identUses([fb[i]!], reg).reads === 0) { killed = true; continue; }
      return true;
    }
  } else if (scope?.fnBody !== undefined && scope.list !== undefined && scope.fnBody !== scope.list) {
    const whole = identUses(scope.fnBody, reg);
    const here = identUses(scope.list, reg);
    if (whole.reads + whole.writes !== here.reads + here.writes) return true;
  }
  for (let i = at + 1; i < before.length; i++) {
    const s = before[i]!;
    if (isHop(s)) continue;
    if (!mentions(s)) continue;
    const store = simpleStore(s);
    if (store !== null && store.name === reg && identUses([s], reg).reads === 0) return false; // killed
    return true;
  }
  return false;
}

/** Where `before` sits: `fnBody` is the whole function body the driver is
 *  folding (`ctx.fnBody`); omitted, `before` IS the whole body (unit tests,
 *  hand-built trees). */
export interface FoldScope {
  readonly fnBody?: readonly Stmt[] | undefined;
  /** The statement list the driver matched (`before` of `foldAll`), which
   *  `fnBody` contains when it is a nested list. */
  readonly list?: readonly Stmt[] | undefined;
}

export function foldAll(before: readonly Stmt[], scope?: FoldScope): { readonly after: readonly Stmt[]; readonly folded: readonly string[] } {
  if (scope?.fnBody === undefined || scope.fnBody === before) {
    const hosted = foldHosted(before);
    if (hosted !== null) return hosted;
  }
  // Spec 24 section 1.7.1: private methods first, so the field fold below
  // reaches a method body as an ordinary member (`./methods.ts`).
  const pm = foldMethods(before, scope === undefined ? undefined : { fnBody: scope.fnBody, list: before });
  const tree = pm !== null && "tree" in pm ? pm.tree : before;
  const folded: string[] = pm !== null && "tree" in pm ? [...pm.methods] : [];
  return foldFields(tree, before, scope === undefined ? null : scope.fnBody, folded);
}

function foldFields(start: readonly Stmt[], list: readonly Stmt[], fnBody: readonly Stmt[] | undefined | null, folded: string[]): { readonly after: readonly Stmt[]; readonly folded: readonly string[] } {
  let tree = start;
  for (const c of findCandidates(list)) {
    const next = foldOne(tree, c, fnBody === null ? undefined : { fnBody, list });
    if (next !== null) {
      tree = next;
      folded.push(c.displayName);
    }
  }
  return { after: tree, folded };
}

/** Section 1.7.1's hosted shape, matched on the whole function body: the
 *  method functions are declared at its top level, the class and the slot
 *  stores inside a labelled block placed directly in it. The methods step
 *  runs on that block (the declarations go from the body), then the field
 *  fold on the new block -- the innermost-first driver already visited the
 *  block itself and found nothing to fold there. No method slot, brand slot
 *  or folded field slot may be mentioned anywhere else in the frame. */
export function foldHosted(fnBody: readonly Stmt[]): { readonly after: readonly Stmt[]; readonly folded: readonly string[]; readonly hostedList: readonly Stmt[]; readonly originalList: readonly Stmt[]; readonly frame: readonly Stmt[] } | null {
  const fns = methodFns(fnBody);
  if (fns.size === 0) return null;
  const i = fnBody.findIndex((s) => s.k === "labeled" && s.body.some((t) => { const st = simpleStore(t); return st !== null && st.value.k === "ident" && fns.has(st.value.name); }));
  if (i < 0) return null;
  const lab = fnBody[i] as Extract<Stmt, { k: "labeled" }>;
  const pm = foldMethods(lab.body, { fnBody, list: lab.body }, fns);
  if (pm === null || "refused" in pm) return null;
  const gone = new Set(pm.fnNames);
  const slots = new Set(pm.slots);
  const newLab: Stmt = { ...lab, body: pm.tree };
  const frame = fnBody.flatMap((x, j): Stmt[] => {
    if (j === i) return [newLab];
    if (x.k === "func" && gone.has(x.name)) return [];
    if (x.k === "decl" && x.names.some((n) => slots.has(n))) { const names = x.names.filter((n) => !slots.has(n)); return names.length === 0 ? [] : [{ ...x, names }]; }
    return [x];
  });
  const fields = foldFields(pm.tree, pm.tree, frame, [...pm.methods]);
  const after = frame.map((x) => (x === newLab ? { ...lab, body: fields.after } : x));
  const fieldSlots = findCandidates(pm.tree).filter((c) => fields.folded.includes(c.displayName)).map((c) => c.envName);
  const left = identUsesMany(after, [...slots, ...fieldSlots]);
  for (const u of left.values()) if (u.reads + u.writes + u.nested > 0) return null;
  return { after, folded: fields.folded, hostedList: pm.tree, originalList: lab.body, frame };
}

export function match(before: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], PrivateFieldsGroup> | null {
  const { folded } = foldAll(before, { fnBody: ctx.fnBody });
  if (folded.length === 0) return null;
  return { root: before, nodes: [before], data: { folded }, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
