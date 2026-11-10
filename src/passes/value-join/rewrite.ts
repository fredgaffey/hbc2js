// value-join writer — docs/specs/passes/32-value-join.md §2.
import type { Stmt } from "../ast.ts";
import type { ValueJoinMatch, ValueJoinSite } from "./match.ts";

export function build(list: readonly Stmt[], site: ValueJoinSite): readonly Stmt[] {
  const commit: Stmt = { k: "expr", expr: { k: "assign", target: { k: "ident", name: site.target }, value: site.value } };
  return [...list.slice(0, site.index), ...site.pre, commit, ...list.slice(site.index + 1)];
}

export function rewrite(m: ValueJoinMatch): readonly Stmt[] {
  return build(m.root, m.data);
}
