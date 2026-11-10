// object-literal-arg checker — docs/specs/passes/20-object-literal.md §9.
// Recompute-and-diff: the site is re-derived from `before` alone.
import type { Stmt } from "../ast.ts";
import { identUses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { match } from "./match.ts";
import { rewrite } from "./rewrite.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const again = match(before, ctx);
  if (again === null) return { ok: false, reason: "no object-literal-arg site recomputed from before" };
  const want = rewrite(again);
  if (again.data.kind === "closure-slot") {
    // Kind D removes the declaration and rewrites the one statement using it.
    if (after.length !== before.length - 1 || JSON.stringify(after) !== JSON.stringify(want)) return { ok: false, reason: "object-literal-arg closure slot differs from the recomputed one" };
    if (identUses(after, again.data.reg).reads !== 0) return { ok: false, reason: "object-literal-arg closure slot left a reference to the moved declaration" };
    return { ok: true };
  }
  if (again.data.kind === "slot-fill") {
    // Kind C rewrites one statement in place; everything else is untouched.
    if (after.length !== before.length) return { ok: false, reason: "object-literal-arg slot fill changed the list length" };
    for (let i = 0; i < want.length; i++) {
      if (i !== again.data.defIndex && after[i] !== before[i]) return { ok: false, reason: "object-literal-arg slot fill touched another statement" };
    }
    if (JSON.stringify(after[again.data.defIndex]) !== JSON.stringify(want[again.data.defIndex])) return { ok: false, reason: "object-literal-arg slot fill differs from the recomputed one" };
    return { ok: true };
  }
  if (want.length !== after.length || after.length !== before.length - 1) return { ok: false, reason: "object-literal-arg did not remove exactly the definition" };
  for (let i = 0; i < want.length; i++) {
    if (want[i] !== after[i] && JSON.stringify(want[i]) !== JSON.stringify(after[i])) return { ok: false, reason: "object-literal-arg changed a statement other than the use" };
  }
  const ub = identUses(before, again.data.reg);
  const ua = identUses(after, again.data.reg);
  if (ua.reads !== ub.reads - 1 || ua.writes !== ub.writes - 1) return { ok: false, reason: "object-literal-arg did not remove exactly one write and one read of the inlined register" };
  return { ok: true };
}
