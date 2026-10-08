// array-literal matcher — docs/specs/passes/31-array-literal.md §4.
//
// Recognises `rN = new Array(k)` (a `NewArray`/`NewFastArray` allocation,
// marked `fromNewArray` — `src/emit/lower.ts`) followed by a contiguous run
// of own-index defines into `rN` at indices exactly `0..k-1`, and folds the
// run back into one array literal at the definition.
import { identUses, isPure, isRegisterName, mapPattern, opcodeAt, originOf } from "../ast.ts";
import type { Expr, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

/**
 * §2: the opcodes the emitter renders as `new Array(k)` carrying
 * `fromNewArray` — the intrinsic array allocation, never a source-level
 * `new Array(x)` (that is a `GetGlobalObject` + `Construct`, which never
 * carries the flag — precondition 1 below). `NewFastArray` is the same
 * shape at the versions that have it.
 */
export const FRESH_ARRAY: ReadonlySet<string> = new Set(["NewArray", "NewFastArray"]);

/**
 * §2/§4 precondition 2: the store opcodes whose semantics are exactly an
 * own-index define, in bracket-literal position. Measured directly
 * (v94/v99 hermesc, docs/lowering/array-literal.md): these ONLY appear as
 * part of the literal's own `[...]` syntax; a *separate* statement index
 * store (`arr[i] = v;`, first-time or not, self-referencing or not) always
 * compiles to `PutByVal`/`PutByValLoose`/`PutByValStrict` instead — a full
 * `[[Set]]`, which walks the prototype chain and is never equivalent to a
 * literal element. Deliberately absent for exactly that reason.
 *
 * `NewArrayWithBuffer`/`NewArrayWithBufferLong` are excluded entirely
 * (precondition 6, checked in `defOf` below, not here): a fully-constant
 * literal already lowers straight to `NewArrayWithBuffer`, which
 * `src/emit/literals.ts` renders as an `array` node directly — nothing for
 * this rung to fold, and a `sizeHint > count` `.length` store on one of
 * those must never be absorbed into a literal either.
 */
export const OWN_INDEX_DEFINE: ReadonlySet<string> = new Set(["PutOwnByIndex", "PutOwnByIndexL", "DefineOwnByIndex", "DefineOwnByIndexL", "DefineOwnInDenseArray", "DefineOwnInDenseArrayL"]);

/** A canonical array index, exactly as `num` renders it for a `PutOwnByIndex`-family key (`src/emit/lower.ts`). */
const INDEX_KEY = /^(?:0|[1-9][0-9]*)$/;

export interface ArrayLiteralSite {
  /**
   * The register the array is built in, or `null` for the "already inlined"
   * `k=0` form (see `inlineEmptyOf` below): `expr-rebuild` runs before this
   * rung and inlines a single-use adjacent register into its sole reader,
   * which is exactly the shape a `k=0` definition with no following store
   * has (nothing else ever reads the register) — by the time this rung
   * looks, there is no `rN = new Array(0);` statement left to find, only
   * a `new Array(0)` node embedded wherever `expr-rebuild` moved it to.
   */
  readonly reg: string | null;
  /** Index, in the matched statement list, of the definition (`reg !== null`)
   *  or of the one statement carrying the inlined node (`reg === null`). */
  readonly defIndex: number;
  /** `k` — the declared size, and (on a match) the exact element count. */
  readonly count: number;
  /** The rebuilt element list, in index order (0..count-1). Always `[]`
   *  when `reg === null`. */
  readonly elements: readonly Expr[];
  /**
   * docs/BUGS.md `array-literal-interleaved` (F1's finding, ported from
   * `object-literal`'s own `canHoist`): statements between two own-index
   * stores that were proven safe to commute above the whole run, in their
   * original relative order. Always `[]` when `reg === null`.
   */
  readonly hoisted: readonly Stmt[];
}

export type ArrayLiteralMatch = Match<readonly Stmt[], ArrayLiteralSite>;

export function opcodeOf(s: Stmt, ctx: PassContext): string | null {
  const o = originOf(s);
  if (o === undefined || o.fn !== ctx.functionIndex) return null;
  return opcodeAt(ctx.cfg, o.start);
}

/** §4 precondition 1/6: `rN = new Array(<literal k>)` carrying `fromNewArray`. */
export function defOf(s: Stmt): { readonly reg: string; readonly count: number } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  if (value.k !== "new" || value.fromNewArray !== true) return null;
  if (value.args.length !== 1 || value.args[0]!.k !== "lit") return null;
  const text = (value.args[0] as Extract<Expr, { k: "lit" }>).text;
  if (!INDEX_KEY.test(text)) return null;
  return { reg: target.name, count: Number(text) };
}

/** §4 precondition 2/3: `rN[i] = v` at a statically known integer index. */
export function storeOf(s: Stmt, reg: string): { readonly index: number; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "member" || !target.computed) return null;
  if (target.obj.k !== "ident" || target.obj.name !== reg) return null;
  if (target.prop.k !== "lit") return null;
  const text = target.prop.text;
  if (!INDEX_KEY.test(text)) return null;
  return { index: Number(text), value };
}

function isEmptyFreshArray(e: Expr): boolean {
  return e.k === "new" && e.fromNewArray === true && e.args.length === 1 && e.args[0]!.k === "lit" && (e.args[0] as Extract<Expr, { k: "lit" }>).text === "0";
}

/**
 * A single-substitution find-and-replace, bounded to the shallow, ordinary
 * expression shapes `expr-rebuild`'s single-use-adjacent inlining can
 * plausibly have produced (call/member/assign/binary/unary/cond/array/seq/
 * spread) — deliberately NOT the framework's general `mapExpr` (`../ast.ts`),
 * which also recurses into a nested `func` node's own body. That recursion
 * is fine for `identUses`-style read-only checks (`object-literal`'s own
 * doc comment calls it "deliberately over-eager"), but a `match` called
 * once per (pass, driver iteration) on EVERY statement list in a module
 * cannot afford to re-walk every nested closure's entire body from every
 * statement that fails this narrow check — that is
 * exactly this shape of accidental O(K^2) blowup on a large bundle's
 * thousand-closure module factory. Stopping at "object"/"func"/"class"/
 * "jsx"/"template"/"tagged"/"destructure"/"await"/"yield" costs this
 * fallback nothing real: `new Array(0)` only ever reaches one of those
 * positions via a further, separate `expr-rebuild` inline of ITS OWN, at
 * which point it is that inliner's target statement (a different site) that
 * this same fallback runs on again next.
 */
function replaceEmptyArrayShallow(e: Expr): { readonly changed: boolean; readonly expr: Expr } {
  if (isEmptyFreshArray(e)) return { changed: true, expr: { k: "array", elements: [] } };
  switch (e.k) {
    case "member":
    case "optmember": {
      const o = replaceEmptyArrayShallow(e.obj);
      if (o.changed) return { changed: true, expr: { ...e, obj: o.expr } };
      const p = replaceEmptyArrayShallow(e.prop);
      return p.changed ? { changed: true, expr: { ...e, prop: p.expr } } : { changed: false, expr: e };
    }
    case "call":
    case "optcall":
    case "new": {
      const c = replaceEmptyArrayShallow(e.callee);
      if (c.changed) return { changed: true, expr: { ...e, callee: c.expr } };
      for (let idx = 0; idx < e.args.length; idx++) {
        const a = replaceEmptyArrayShallow(e.args[idx]!);
        if (a.changed) {
          const args = [...e.args];
          args[idx] = a.expr;
          return { changed: true, expr: { ...e, args } };
        }
      }
      return { changed: false, expr: e };
    }
    case "bin":
    case "logical": {
      const l = replaceEmptyArrayShallow(e.left);
      if (l.changed) return { changed: true, expr: { ...e, left: l.expr } };
      const r = replaceEmptyArrayShallow(e.right);
      return r.changed ? { changed: true, expr: { ...e, right: r.expr } } : { changed: false, expr: e };
    }
    case "unary": {
      const a = replaceEmptyArrayShallow(e.arg);
      return a.changed ? { changed: true, expr: { ...e, arg: a.expr } } : { changed: false, expr: e };
    }
    case "assign": {
      const t = replaceEmptyArrayShallow(e.target);
      if (t.changed) return { changed: true, expr: { ...e, target: t.expr } };
      const v = replaceEmptyArrayShallow(e.value);
      return v.changed ? { changed: true, expr: { ...e, value: v.expr } } : { changed: false, expr: e };
    }
    case "cond": {
      const t = replaceEmptyArrayShallow(e.test);
      if (t.changed) return { changed: true, expr: { ...e, test: t.expr } };
      const th = replaceEmptyArrayShallow(e.then);
      if (th.changed) return { changed: true, expr: { ...e, then: th.expr } };
      const el = replaceEmptyArrayShallow(e.else);
      return el.changed ? { changed: true, expr: { ...e, else: el.expr } } : { changed: false, expr: e };
    }
    case "array": {
      for (let idx = 0; idx < e.elements.length; idx++) {
        const x = replaceEmptyArrayShallow(e.elements[idx]!);
        if (x.changed) {
          const elements = [...e.elements];
          elements[idx] = x.expr;
          return { changed: true, expr: { ...e, elements } };
        }
      }
      return { changed: false, expr: e };
    }
    case "spread": {
      const a = replaceEmptyArrayShallow(e.arg);
      return a.changed ? { changed: true, expr: { ...e, arg: a.expr } } : { changed: false, expr: e };
    }
    case "seq": {
      for (let idx = 0; idx < e.exprs.length; idx++) {
        const x = replaceEmptyArrayShallow(e.exprs[idx]!);
        if (x.changed) {
          const exprs = [...e.exprs];
          exprs[idx] = x.expr;
          return { changed: true, expr: { ...e, exprs } };
        }
      }
      return { changed: false, expr: e };
    }
    case "destructure": {
      // F16: a pattern element's `init` (a default value, e.g. `{tags = new
      // Array(0)} = r1`) is the one shape besides the ordinary-expression
      // cases above this rung's `k=0` fallback needs — `39-destructuring-
      // params` at every version. Scoped to `mapPattern`'s own (bounded:
      // once per destructure statement, not once per arbitrary statement in
      // the module) recursion rather than adding pattern-walking here.
      const src = replaceEmptyArrayShallow(e.source);
      if (src.changed) return { changed: true, expr: { ...e, source: src.expr } };
      let patternChanged = false;
      const pattern = mapPattern(e.pattern, (x) => {
        if (!patternChanged && isEmptyFreshArray(x)) {
          patternChanged = true;
          return { k: "array", elements: [] };
        }
        return x;
      });
      return patternChanged ? { changed: true, expr: { ...e, pattern } } : { changed: false, expr: e };
    }
    default:
      return { changed: false, expr: e };
  }
}

/**
 * §4 precondition 5's `k=0` case, as it actually appears in the default
 * pipeline: `expr-rebuild` (registered before this rung, §7) inlines a
 * single-use adjacent register into its sole reader, and a `k=0`
 * definition with no following store is exactly that shape — by the time
 * this rung runs there is no standalone `rN = new Array(0);` statement
 * left, only a `new Array(0)` node wherever `expr-rebuild` moved it
 * (`return new Array(0);`, a call argument, …). `fromNewArray` is itself
 * the whole provenance proof here (as `literal-forms`'s `fromRegExpTable`
 * needs no opcode cross-check either) — no origin survives on the
 * embedded node to re-derive an opcode from once it has moved.
 */
export function inlineEmptyOf(s: Stmt): Stmt | null {
  switch (s.k) {
    case "expr": {
      const r = replaceEmptyArrayShallow(s.expr);
      return r.changed ? { ...s, expr: r.expr } : null;
    }
    case "init": {
      const r = replaceEmptyArrayShallow(s.value);
      return r.changed ? { ...s, value: r.expr } : null;
    }
    case "return": {
      if (s.arg === null) return null;
      const r = replaceEmptyArrayShallow(s.arg);
      return r.changed ? { ...s, arg: r.expr } : null;
    }
    case "throw": {
      const r = replaceEmptyArrayShallow(s.arg);
      return r.changed ? { ...s, arg: r.expr } : null;
    }
    default:
      return null;
  }
}

/**
 * §4 precondition 1's named refusal: `list[i]` LOOKS like this rung's def
 * shape (`rN = new Array(k)`/`new Array`) syntactically, but the value
 * does not carry `fromNewArray` — a source-level `new Array(x)` (a
 * `GetGlobalObject` read plus `Construct`, never this opcode's rendering).
 */
function looksLikeSourceNewArray(s: Stmt): boolean {
  if (s.k !== "expr" || s.expr.k !== "assign") return false;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return false;
  return value.k === "new" && value.callee.k === "ident" && value.callee.name === "Array" && value.fromNewArray !== true;
}

/**
 * docs/BUGS.md `array-literal-interleaved` (F1's finding; ported from
 * `object-literal`'s own `canHoist`/`freshRegisterDef`, docs/specs/passes/
 * 20-object-literal.md §4, `object-literal-interleaved`). `s` is
 * `rX = <pure expr>` — `isPure` (no calls, no member access, no
 * `in`/`instanceof`) means the only things `s` can possibly do are (a)
 * write `rX` and (b) read whatever registers/names appear in the
 * expression; it cannot call anything, throw, or touch the array. That is
 * exactly the shape `canHoist` needs: a candidate whose entire observable
 * behaviour is a register-to-register dataflow edge.
 */
export function freshRegisterDef(s: Stmt): { readonly reg: string; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  if (!isPure(value)) return null;
  return { reg: target.name, value };
}

/** Every register name `e` reads — `e` is proven `isPure`, so this is a
 *  complete, terminating walk of a `lit`/`ident`/`unary`/`bin`/`logical`/
 *  `cond` tree (the only kinds `isPure` accepts). */
function pureExprRegisterReads(e: Expr, out: string[]): void {
  switch (e.k) {
    case "ident":
      if (isRegisterName(e.name)) out.push(e.name);
      return;
    case "unary":
      pureExprRegisterReads(e.arg, out);
      return;
    case "bin":
    case "logical":
      pureExprRegisterReads(e.left, out);
      pureExprRegisterReads(e.right, out);
      return;
    case "cond":
      pureExprRegisterReads(e.test, out);
      pureExprRegisterReads(e.then, out);
      pureExprRegisterReads(e.else, out);
      return;
    default:
      return;
  }
}

/**
 * docs/BUGS.md `array-literal-interleaved`'s commutation check, ported from
 * `object-literal`'s own (see that pass's `match.ts` doc comment for the
 * full proof — identical reasoning, `reg` is the array's register instead
 * of the object's): a candidate `rX = <pure expr>` sitting at `list[j]`,
 * inside a run that starts at `list[i]` (the definition), commutes above
 * the whole run collected so far — `list[i..j)` — iff:
 *
 *  1. `rX` is read nowhere in `list[0..j)`.
 *  2. Every register `rX`'s value expression reads has zero writes in
 *     `runNonHoisted` (the definition plus every store already folded —
 *     an own-index store's target is always a `member` expression, never
 *     a plain register, so the only statement in there that ever counts as
 *     *writing* a register is the definition itself, exactly like
 *     `object-literal`'s own `consumed` list).
 *  3. `rX !== reg` — a candidate may not silently redefine the array being
 *     built.
 */
export function canHoist(list: readonly Stmt[], j: number, reg: string, runNonHoisted: readonly Stmt[], candidate: { readonly reg: string; readonly value: Expr }): boolean {
  if (candidate.reg === reg) return false;
  if (identUses(list.slice(0, j), candidate.reg).reads > 0) return false;
  const reads: string[] = [];
  pureExprRegisterReads(candidate.value, reads);
  for (const r of reads) {
    if (identUses(runNonHoisted, r).writes > 0) return false;
  }
  return true;
}

export function match(list: readonly Stmt[], ctx: PassContext): ArrayLiteralMatch | null {
  for (let i = 0; i < list.length; i++) {
    const def = defOf(list[i]!);
    if (def === null) {
      if (inlineEmptyOf(list[i]!) !== null) {
        return { root: list, nodes: [list], data: { reg: null, defIndex: i, count: 0, elements: [], hoisted: [] }, at: { functionIndex: ctx.functionIndex, offset: originOf(list[i]!)?.start ?? 0 } };
      }
      if (looksLikeSourceNewArray(list[i]!)) ctx.refuse?.(list[i]!, "no-from-new-array-provenance");
      continue;
    }
    const defOp = opcodeOf(list[i]!, ctx);
    if (defOp === null || !FRESH_ARRAY.has(defOp)) continue;

    // §4 precondition 5: `k = 0` with no stores folds to `[]` immediately.
    if (def.count === 0) {
      return { root: list, nodes: [list], data: { reg: def.reg, defIndex: i, count: 0, elements: [], hoisted: [] }, at: { functionIndex: ctx.functionIndex, offset: originOf(list[i]!)?.start ?? 0 } };
    }

    const elements: Expr[] = [];
    let next = 0;
    const hoisted: Stmt[] = [];
    // Everything the run has consumed so far that is NOT a hoisted
    // candidate — the definition plus every store already folded — used by
    // `canHoist`'s precondition 2, exactly like `object-literal`'s own
    // `consumed` list.
    const consumed: Stmt[] = [list[i]!];
    for (let j = i + 1; j < list.length && next < def.count; j++) {
      const op = opcodeOf(list[j]!, ctx);
      if (op !== null && OWN_INDEX_DEFINE.has(op)) {
        const st = storeOf(list[j]!, def.reg);
        if (st !== null && st.index === next) {
          // §4 precondition 4: the value must not read or write the
          // register the array is being built in (defensive: unreachable
          // via real Hermes bytecode, see docs/specs/passes/31-array-
          // literal.md §4 — every reachable own-index store is part of the
          // literal's own bracket syntax, evaluated before the register is
          // exposed anywhere).
          const u = identUses([{ k: "expr", expr: st.value }], def.reg);
          if (u.reads + u.writes > 0) {
            ctx.refuse?.(list[j]!, "self-referencing-element");
            break;
          }
          elements.push(st.value);
          consumed.push(list[j]!);
          next++;
          continue;
        }
        // §4 precondition 3: an own-index store, but not at the index this
        // run needs next (out of order, a gap, or a repeat) — never a hoist
        // candidate (its target is a `member` expression, not a plain
        // register), so it ends the run right here.
        ctx.refuse?.(list[j]!, "index-gap-or-repeat");
        break;
      }
      // Not an own-index store: docs/BUGS.md `array-literal-interleaved` —
      // try to hoist it above the run (`canHoist`) instead of ending the
      // run outright. Folding across a hoisted statement is sound by
      // `canHoist`'s proof (identical to `object-literal`'s own); folding
      // across anything else (a call, an unproven register dependency, a
      // redefinition of the array's own register) would move an effect, or
      // a read, across a statement whose reordering is not proven safe, so
      // the run ends there instead.
      const fresh = freshRegisterDef(list[j]!);
      if (fresh !== null && canHoist(list, j, def.reg, consumed, fresh)) {
        hoisted.push(list[j]!);
        continue;
      }
      ctx.refuse?.(list[j]!, "non-own-index-store");
      break;
    }
    // §4 precondition 5: a partial run (elements.length !== k) is refused,
    // never patched with a `.length` store.
    if (elements.length !== def.count) {
      ctx.refuse?.(list[i]!, "partial-run");
      continue;
    }
    return { root: list, nodes: [list], data: { reg: def.reg, defIndex: i, count: def.count, elements, hoisted }, at: { functionIndex: ctx.functionIndex, offset: originOf(list[i]!)?.start ?? 0 } };
  }
  return null;
}
