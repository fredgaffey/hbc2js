// closure-inline writer: delete the declaration, put the same function (as a
// named function expression) in place of its one read. Nothing else moves.
import { mapStmts } from "../ast.ts";
import type { Expr, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { ClosureInlineSite } from "./match.ts";

export function inlineAt(body: readonly Stmt[], site: ClosureInlineSite): readonly Stmt[] {
  const f = body[site.index] as Stmt & { readonly k: "func" };
  const fnExpr: Expr = {
    k: "func",
    name: f.name,
    params: f.params,
    body: f.body,
    ...(f.generator === true ? { generator: true as const } : {}),
    ...(f.async === true ? { async: true as const } : {}),
  };
  const rest = body.filter((_, i) => i !== site.index);
  return mapStmts(rest, (s) => s, (e) => (e.k === "ident" && e.name === site.name ? fnExpr : e));
}

export function rewrite(m: Match<readonly Stmt[], ClosureInlineSite>, _ctx: PassContext): readonly Stmt[] {
  return inlineAt(m.nodes[0]!, m.data);
}
