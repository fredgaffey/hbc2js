// inline-new checker -- docs/specs/passes/24-class-recover.md section 9.4.
// The rewrite deletes the inlined body's effects (they now run inside the
// constructor), so `effectSequence` equality cannot be its guard. The
// obligation is: an independent re-derivation from `before` produces exactly
// `after`, the fold count is the one the writer claimed, no free name appears
// and the result parses. The equivalence argument itself is the matcher's
// lock-step comparison (section 9.2), re-run here from scratch.
import type { Stmt } from "../ast.ts";
import { freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { foldAll } from "./match.ts";

export function check(before: readonly Stmt[], after: readonly Stmt[], _ctx: PassContext): CheckResult {
  const rebuilt = foldAll(before);
  if (rebuilt.folded === 0) return { ok: false, reason: "inline-new produced no construction to re-derive" };
  if (JSON.stringify(rebuilt.after) !== JSON.stringify(after)) return { ok: false, reason: "inline-new rewrote the body differently from its own re-derivation" };
  const beforeFree = freeNames(before);
  for (const name of freeNames(after)) if (!beforeFree.has(name)) return { ok: false, reason: `inline-new introduced the free name ${name}` };
  if (!parses(after)) return { ok: false, reason: "inline-new produced a body that does not parse" };
  return { ok: true };
}
