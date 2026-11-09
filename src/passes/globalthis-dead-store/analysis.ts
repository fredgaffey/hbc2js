// globalthis-dead-store analysis — docs/LOWERING-CATALOGUE.md R11,
// docs/BUGS.md 2026-09-01 "`r0 = globalThis` dead store survives the
// global-access rewrite".
//
// `global-access`'s writer (spec 03 section 5) deletes the guard `if` and
// folds the guarded read to a bare identifier, but deliberately leaves the
// `rN = globalThis` store that fed it: `expr-rebuild` has already reached
// its fixed point by the time `global-access` runs (stage B passes run once
// each, in registry order), so the store still had a read after it when
// `expr-rebuild`'s R1b dead-store rule looked at it. `var-naming` (spec 07
// section 4.2 item 2) then refuses on purpose to touch a `globalThis` alias
// ("a rename-only pass cannot delete the binding"), so without this rung the
// dead store rides all the way to emit and round-trips as a live
// `GetGlobalObject`+`TryGetById` that `hermesc -O` cannot prove dead.
import type { Stmt } from "../ast.ts";
import { analyzeWith, applyAnalysis, isRegisterName } from "../ast.ts";
import type { DeadStoreAnalysis } from "../ast.ts";

export type Analysis = DeadStoreAnalysis;
export { applyAnalysis };


/** Is `s` exactly the statement shape `src/emit/lower.ts`'s `GetGlobalObject`
 *  case emits (`set(dst, id("globalThis"))`, i.e. `assign(R(dst),
 *  id("globalThis"))`) — the only shape this rung may ever delete. */
function isGlobalThisStore(s: Stmt): { readonly reg: string } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  if (value.k !== "ident" || value.name !== "globalThis") return null;
  return { reg: target.name };
}


/**
 * Every `globalThis`-store statement, anywhere in `fnBody` (at any nesting
 * depth, never inside a nested `func`'s own frame — `stmtLists` already
 * excludes those), that `isDeadLocally` proves dead, or that has zero
 * remaining reads in the whole function when the local scan is
 * inconclusive (the "unknown" verdict, above — sound because "no read
 * anywhere" trivially implies "no read reachable from here" too). Sound:
 * reading the identifier `globalThis` can never throw or observe
 * anything, a plain `=` never reads its own target first, and `identUses`
 * never follows a register name across a `func` boundary, so a nested
 * closure's own same-numbered register can never hide behind either check
 * (see `IdentUses.nested`'s doc in `src/passes/ast.ts`).
 */
export function analyze(fnBody: readonly Stmt[]): Analysis {
  return analyzeWith(fnBody, (list, k) => isGlobalThisStore(list[k]!));
}

