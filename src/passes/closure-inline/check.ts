// closure-inline checker: re-derive the site from `before` (never trust the
// Match), require `after` to be exactly that one move, and that it parses and
// introduces no free name.
import { freeNames, parses } from "../ast.ts";
import type { Stmt } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { findSite } from "./match.ts";
import { inlineAt } from "./rewrite.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], _ctx: PassContext): CheckResult {
  const site = findSite(before);
  if (site === null) return { ok: false, reason: "closure-inline has no site to re-derive" };
  if (JSON.stringify(inlineAt(before, site)) !== JSON.stringify(after)) return { ok: false, reason: "closure-inline's result is not exactly the declared move" };
  if (!parses(after)) return { ok: false, reason: "closure-inline result does not parse" };
  const freeBefore = freeNames(before);
  for (const n of freeNames(after)) if (!freeBefore.has(n)) return { ok: false, reason: `closure-inline introduced a new free name: ${n}` };
  return { ok: true };
}
