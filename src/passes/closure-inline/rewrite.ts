// closure-inline writer: delete each accepted declaration and put the same
// function (a named function expression) in place of its one read. Nothing
// else moves.
import { mapStmts } from "../ast.ts";
import type { Expr, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { ClosureInlineSite } from "./match.ts";

export function inlineAt(body: readonly Stmt[], site: ClosureInlineSite): readonly Stmt[] {
  const moving = new Set(site.names);
  const exprs = new Map<string, Expr>();
  const rest: Stmt[] = [];
  for (const s of body) {
    if (s.k === "func" && moving.has(s.name)) {
      exprs.set(s.name, {
        k: "func",
        name: s.name,
        params: s.params,
        body: s.body,
        ...(s.generator === true ? { generator: true as const } : {}),
        ...(s.async === true ? { async: true as const } : {}),
      });
    } else rest.push(s);
  }
  return mapStmts(rest, (s) => s, (e) => (e.k === "ident" ? exprs.get(e.name) ?? e : e));
}

export function rewrite(m: Match<readonly Stmt[], ClosureInlineSite>, _ctx: PassContext): readonly Stmt[] {
  return inlineAt(m.nodes[0]!, m.data);
}
