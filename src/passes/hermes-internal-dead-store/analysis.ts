// hermes-internal-dead-store analysis — docs/LOWERING-CATALOGUE.md R18,
// docs/specs/passes/14-template-literal.md section 9 (roundtrip review
// `diff:TryGetById(reg)` bucket, 2026-11-10).
//
// `template-literal` replaces `Reflect.apply(concat, C0, [...])` by a
// template literal but leaves the callee spill that fed it — `rN =
// __hbc_HermesInternal.concat`, or the namespace pair `rM =
// __hbc_HermesInternal; rN = rM.concat` when Hermes had reused `rM` — and it
// runs after `globalthis-dead-store`, so nothing deletes that store. The
// recompile then reads the prelude's `__hbc_HermesInternal` (a global `var`:
// TryGetById, which hermesc -O must keep because it may throw) on top of the
// `HermesInternal` read the template literal itself compiles to.
//
// Sound: `__hbc_HermesInternal` is the decompiler's own prelude `var`
// (src/runtime/helpers.ts), always declared when referenced, a plain object
// whose every property is a data property, so reading it or any named
// property of it can neither throw nor run user code. The `rM.concat` form is
// accepted only when the statement immediately before it, in the same list,
// is `rM = __hbc_HermesInternal` — nothing can run between the two. The
// deadness proof is `globalthis-dead-store`'s own (`analyzeWith`), iterated
// to a fixed point so a namespace store whose only reader was a deleted
// member read goes too, plus one extension (`exitIsDead`): in a function with
// no `try` anywhere, a `return`/`throw` reached before any read of the
// register ends its life (no `finally` or `catch` can see it afterwards).
import type { Expr, Stmt } from "../ast.ts";
import { isRegisterName } from "../ast.ts";
import type { DeadStoreAnalysis as Analysis } from "../ast.ts";
import { analyzeWith, applyAnalysis } from "../ast.ts";

export const HERMES_INTERNAL_SHIM = "__hbc_HermesInternal";

const isShim = (e: Expr): boolean => e.k === "ident" && e.name === HERMES_INTERNAL_SHIM;

function registerStore(s: Stmt | undefined): { readonly reg: string; readonly value: Expr } | null {
  if (s === undefined || s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  return { reg: target.name, value };
}

/** `rN = __hbc_HermesInternal`, `rN = __hbc_HermesInternal.p`, or
 *  `rN = rM.p` right after `rM = __hbc_HermesInternal`. */
function isShimStore(list: readonly Stmt[], k: number): { readonly reg: string } | null {
  const st = registerStore(list[k]);
  if (st === null) return null;
  const v = st.value;
  if (isShim(v)) return { reg: st.reg };
  if (v.k !== "member" || v.computed || v.prop.k !== "lit") return null;
  if (isShim(v.obj)) return { reg: st.reg };
  if (v.obj.k !== "ident") return null;
  const prev = registerStore(k > 0 ? list[k - 1] : undefined);
  return prev !== null && prev.reg === v.obj.name && isShim(prev.value) ? { reg: st.reg } : null;
}

/** Every dead shim store in `fnBody`, to a fixed point. */
export function analyzeHermesInternal(fnBody: readonly Stmt[]): Analysis {
  const deadStores = new Set<Stmt>();
  const deadRegisters = new Map<Stmt, string>();
  let body = fnBody;
  for (;;) {
    const a = analyzeWith(body, isShimStore, { exitIsDead: true });
    if (a.deadStores.size === 0) return { deadStores, deadRegisters };
    for (const [s, r] of a.deadRegisters) {
      deadStores.add(s);
      deadRegisters.set(s, r);
    }
    body = applyAnalysis(body, a);
  }
}
