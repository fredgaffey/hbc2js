// method-read writer — spec 05 section 7.4.
import type { Stmt } from "../ast.ts";
import type { MethodReadMatch } from "./match.ts";

export function rewrite(m: MethodReadMatch): readonly Stmt[] {
  const { from, to, stmts } = m.data;
  return [...m.root.slice(0, from), ...stmts, ...m.root.slice(to + 1)];
}
