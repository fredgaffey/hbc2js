// Reuses src/split/tag.ts's `classify` -- the same top-level
// copy-propagation `rewriteFactoryBody` (D17i) already trusts to resolve
// `require(dependencyMap[i])`'s index -- so a `let three = 3; list[three]`
// chain resolves exactly as a literal `list[3]` would. An index this cannot
// trace back to a numeric literal through simple, non-branching top-level
// statements (a real parameter, a loop variable, anything computed) is left
// completely alone: never guessed, never annotated.
import type { Expr, Stmt } from "../emit/ast.ts";
import { mapExpr } from "../passes/ast.ts";
import { classify, type Tag } from "./tag.ts";

export interface AnnotateDepReadsResult {
  readonly body: readonly Stmt[];
  /** Count of comments actually added -- by construction, always equal to
   *  the count of member-access sites this pass could prove constant. */
  readonly annotated: number;
}

function commentFor(moduleId: number, packageOf: ((id: number) => string | undefined) | undefined): string {
  const pkg = packageOf?.(moduleId);
  return pkg !== undefined ? `module ${moduleId}: ${pkg}` : `module ${moduleId}`;
}

/** `params`: the factory's own parameter names (`Param.name` order) --
 *  `params[params.length - 1]` is the dependencyMap parameter, same
 *  convention `src/split/tag.ts`'s `rewriteFactoryBody` uses. `depIds`:
 *  `SplitModuleInfo.deps` (dependencyMap-index order, item 5's `DepEdge`
 *  order) -- index `i` resolves to module id `depIds[i]`; an index outside
 *  `[0, depIds.length)` is never annotated (no data to guess from). */
export function annotateDependencyReads(body: readonly Stmt[], params: readonly string[], depIds: readonly number[], packageOf?: (moduleId: number) => string | undefined): AnnotateDepReadsResult {
  const depMapParam = params[params.length - 1];
  const paramNames = new Set(params);
  const regs = new Map<string, Tag>();
  let annotated = 0;

  const annotateOne = (e: Expr): Expr => {
    if (e.k !== "member" || e.comment !== undefined) return e;
    const tag = classify(e, regs, paramNames);
    if (!(tag.kind === "prop" && tag.objTag !== null && tag.objTag.kind === "param" && depMapParam !== undefined && tag.objTag.name === depMapParam && /^\d+$/.test(tag.name))) return e;
    const idx = Number(tag.name);
    if (idx < 0 || idx >= depIds.length) return e; // out of range: no module id to attach, never guess
    annotated++;
    return { ...e, comment: commentFor(depIds[idx]!, packageOf) };
  };
  const annotateExpr = (e: Expr): Expr => mapExpr(e, annotateOne);

  const out = body.map((s): Stmt => {
    if (s.k === "init") {
      const value = annotateExpr(s.value);
      regs.set(s.name, classify(s.value, regs, paramNames));
      return value === s.value ? s : { ...s, value };
    }
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") {
      const value = annotateExpr(s.expr.value);
      regs.set(s.expr.target.name, classify(s.expr.value, regs, paramNames));
      return value === s.expr.value ? s : { ...s, expr: { ...s.expr, value } };
    }
    if (s.k === "expr") {
      const e = annotateExpr(s.expr);
      return e === s.expr ? s : { ...s, expr: e };
    }
    if (s.k === "return" && s.arg !== null) {
      const arg = annotateExpr(s.arg);
      return arg === s.arg ? s : { ...s, arg };
    }
    if (s.k === "throw") {
      const arg = annotateExpr(s.arg);
      return arg === s.arg ? s : { ...s, arg };
    }
    return s;
  });
  return { body: out, annotated };
}
