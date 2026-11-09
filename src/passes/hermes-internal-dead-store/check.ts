// hermes-internal-dead-store check: the deletions re-derived from `before`
// (never trusted from the match) must reproduce `after` exactly, `after`
// parses, and no free name appears that `before` did not have.
import { freeNames, parses } from "../ast.ts";
import type { Stmt } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { applyAnalysis } from "../globalthis-dead-store/analysis.ts";
import { match } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const m = match(before, ctx);
  if (m === null) return { ok: false, reason: "hermes-internal-dead-store has no matching site to re-derive the deletions from" };
  if (JSON.stringify(applyAnalysis(before, m.data)) !== JSON.stringify(after)) return { ok: false, reason: "hermes-internal-dead-store's result is not exactly the declared deletions applied to `before`" };
  if (!parses(after)) return { ok: false, reason: "hermes-internal-dead-store result does not parse" };
  const freeBefore = freeNames(before);
  for (const n of freeNames(after)) if (!freeBefore.has(n)) return { ok: false, reason: `hermes-internal-dead-store introduced a new free name: ${n}` };
  return { ok: true };
}
