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
  if (want.length !== after.length || after.length !== before.length - 1) return { ok: false, reason: "object-literal-arg did not remove exactly the definition" };
  for (let i = 0; i < want.length; i++) {
    if (want[i] !== after[i] && JSON.stringify(want[i]) !== JSON.stringify(after[i])) return { ok: false, reason: "object-literal-arg changed a statement other than the use" };
  }
  const ub = identUses(before, again.data.reg);
  const ua = identUses(after, again.data.reg);
  if (ua.reads !== ub.reads - 1 || ua.writes !== ub.writes - 1) return { ok: false, reason: "object-literal-arg did not remove exactly one write and one read of the inlined register" };
  return { ok: true };
}
