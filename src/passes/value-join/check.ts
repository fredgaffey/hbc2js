// value-join checker — docs/specs/passes/32-value-join.md §3. Recompute and
// compare: the site is re-derived from `before` by the real matcher and the
// written list must be exactly what the writer builds from it, so a writer
// that reorders an arm, drops a lead expression or keeps the label fails.
import type { Stmt } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { match } from "./match.ts";
import { build } from "./rewrite.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "value-join: site no longer matches" };
  const want = build(before, m.data);
  if (JSON.stringify(want) !== JSON.stringify(after)) return { ok: false, reason: "value-join: written list differs from the recomputed join" };
  return { ok: true };
}
