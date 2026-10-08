// array-literal checker — docs/specs/passes/31-array-literal.md §6.
//
// Recompute-and-diff (the `object-literal`/`optional-chain` pattern):
// nothing here trusts the driver's captured match data. The site is
// re-derived from `before` alone by re-running the real matcher, and the
// written literal is compared element by element against that
// re-derivation.
import type { Expr, Stmt } from "../ast.ts";
import { identUses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { inlineEmptyOf, match } from "./match.ts";

function sameExpr(a: Expr, b: Expr): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const rescan = match(before, ctx);
  if (rescan === null) return { ok: false, reason: "no array-literal site recomputed from before" };
  const site = rescan.data;

  if (site.reg === null) {
    if (after.length !== before.length) return { ok: false, reason: "array-literal (inline k=0) changed the statement count" };
    for (let i = 0; i < before.length; i++) {
      if (i === site.defIndex) continue;
      if (before[i] !== after[i]) return { ok: false, reason: "array-literal (inline k=0) changed a statement other than the one it rewrote" };
    }
    const want = inlineEmptyOf(before[site.defIndex]!);
    if (JSON.stringify(after[site.defIndex]) !== JSON.stringify(want)) {
      return { ok: false, reason: "array-literal (inline k=0) rewrote the statement to something other than the recomputed substitution" };
    }
    return { ok: true };
  }

  if (after.length !== before.length - site.count) return { ok: false, reason: "array-literal did not remove exactly the folded stores" };
  for (let i = 0; i < site.defIndex; i++) {
    if (before[i] !== after[i]) return { ok: false, reason: "array-literal changed a statement before the definition" };
  }
  // `hoisted` statements are relocated, not deleted, so they must survive
  // verbatim, in order, right before the rebuilt literal (same pattern as
  // `object-literal`'s own checker).
  for (let k = 0; k < site.hoisted.length; k++) {
    if (after[site.defIndex + k] !== site.hoisted[k]) return { ok: false, reason: "array-literal did not hoist the interleaved statement verbatim, in order" };
  }
  const replIndex = site.defIndex + site.hoisted.length;
  const span = site.count + site.hoisted.length;
  for (let i = replIndex + 1, origI = site.defIndex + 1 + span; i < after.length; i++, origI++) {
    if (after[i] !== before[origI]) return { ok: false, reason: "array-literal changed a statement after the folded run" };
  }

  const repl = after[replIndex];
  if (repl === undefined || repl.k !== "expr" || repl.expr.k !== "assign" || repl.expr.target.k !== "ident" || repl.expr.target.name !== site.reg) {
    return { ok: false, reason: "array-literal replacement is not `rN = <array>`" };
  }
  const value = repl.expr.value;
  if (value.k !== "array") return { ok: false, reason: "array-literal replacement value is not an array literal" };
  if (value.elements.length !== site.elements.length) return { ok: false, reason: "array-literal element count differs from the recomputed site" };
  for (let i = 0; i < value.elements.length; i++) {
    if (!sameExpr(value.elements[i]!, site.elements[i]!)) return { ok: false, reason: "array-literal element value is not the store's own value expression, in order" };
  }
  // Belt and braces on §4 precondition 4, restated on the *written* tree: no
  // element may read or write the register the array literal is assigned to.
  const written = value.elements.map((e): Stmt => ({ k: "expr", expr: e }));
  const u = identUses(written, site.reg);
  if (u.reads + u.writes > 0) return { ok: false, reason: "array-literal element value reads the array being built" };
  void ctx;
  return { ok: true };
}
