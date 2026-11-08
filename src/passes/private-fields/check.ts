// private-fields checker. Independent re-derivation (never trust the writer's
// own data): recompute `foldAll(before)` and require exactly the same result,
// then the two obligations a field-declaration rewrite must keep -- no new
// free name (every reference this rung deletes is one it also replaces with
// an equivalent, so nothing a class body still needs can go missing), and the
// result still parses. `AddOwnPrivateBySym`/`Get/PutOwnPrivateBySym`/
// `PrivateIsIn` have no other observable side effect to preserve (unlike
// class-recover's method installs, a private-name declare-and-initialise
// *is* exactly a class field declaration's own semantics -- there is no
// third form to diff against), so this checker does not need
// `effectSequence`.
import type { Stmt } from "../ast.ts";
import { freeNames, parses } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { foldAll } from "./match.ts";

function sameStmt(a: Stmt, b: Stmt): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const rebuilt = foldAll(before, { fnBody: ctx.fnBody });
  if (rebuilt.folded.length === 0) return { ok: false, reason: "private-fields produced no name to re-derive" };
  if (rebuilt.after.length !== after.length) return { ok: false, reason: "private-fields changed a statement count the re-derived fold does not account for" };
  for (let i = 0; i < after.length; i++) {
    if (!sameStmt(rebuilt.after[i]!, after[i]!)) return { ok: false, reason: `private-fields rewrote statement ${i} differently from its own re-derivation` };
  }
  const beforeFree = freeNames(before);
  for (const name of freeNames(after)) {
    if (beforeFree.has(name) || frameBound(name, after, ctx.fnBody)) continue;
    return { ok: false, reason: `private-fields introduced the free name ${name}` };
  }
  if (!parses(after)) return { ok: false, reason: "private-fields produced a body that does not parse" };
  return { ok: true };
}

/** `freeNames` is scope-naive: a `let r3` inside a constructor this rung
 *  folds away used to "declare" `r3` for the whole matched list, so the
 *  frame's own later uses of its register `r3` read as newly free. Such a
 *  name is not new when the matched list is nested in the function body,
 *  that body declares it at its top level, and every mention left in `after`
 *  sits outside any nested function or class -- those mentions resolve to the
 *  frame's binding before and after alike. */
function frameBound(name: string, after: readonly Stmt[], fnBody: readonly Stmt[] | undefined): boolean {
  if (fnBody === undefined || fnBody === after) return false;
  if (!fnBody.some((s) => (s.k === "decl" && s.names.includes(name)) || (s.k === "init" && s.name === name))) return false;
  let nested = false;
  const visit = (n: unknown, inner: boolean): void => {
    if (nested) return;
    if (Array.isArray(n)) { for (const x of n) visit(x, inner); return; }
    if (n === null || typeof n !== "object") return;
    const o = n as { k?: string; name?: string };
    if (inner && ((o.k === "ident" && o.name === name) || ((o.k === "init" || o.k === "func") && o.name === name) || (o.k === "decl" && (o as { names?: string[] }).names?.includes(name)))) { nested = true; return; }
    const deeper = inner || o.k === "func" || o.k === "class";
    for (const v of Object.values(o)) if (v !== null && typeof v === "object") visit(v, deeper);
  };
  visit(after, false);
  return !nested;
}
