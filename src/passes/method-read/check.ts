// method-read checker — spec 05 section 7.4. Recompute-and-diff: the splice is
// re-derived from `before` alone and `after` must be exactly it.
import type { Stmt } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { matchSite } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const site = matchSite(before, ctx.fnBody ?? before);
  if (site === null) return { ok: false, reason: "no method-read site recomputed from before" };
  const want = [...before.slice(0, site.from), ...site.stmts, ...before.slice(site.to + 1)];
  if (want.length !== after.length || JSON.stringify(want) !== JSON.stringify(after)) return { ok: false, reason: "method-read: after is not the recomputed splice" };
  return { ok: true };
}
