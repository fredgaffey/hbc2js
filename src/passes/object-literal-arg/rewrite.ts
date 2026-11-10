// object-literal-arg writer — docs/specs/passes/20-object-literal.md §9.
import type { Expr, Stmt } from "../ast.ts";
import { callOf, withCall } from "./match.ts";
import type { ArgInlineMatch } from "./match.ts";

export function rewrite(m: ArgInlineMatch): readonly Stmt[] {
  const { root: list, data: site } = m;
  if (site.kind === "slot-fill") return [...list.slice(0, site.defIndex), site.stmt!, ...list.slice(site.defIndex + 1)];
  if (site.kind === "closure-slot") return list.flatMap((s, i) => (i === site.defIndex ? [] : i === site.useIndex ? [site.stmt!] : [s]));
  const use = list[site.useIndex]!;
  const call = callOf(use, site.kind === "callee-base")!;
  const isReg = (e: Expr): boolean => e.k === "ident" && e.name === site.reg;
  const next: Expr =
    site.kind === "literal-arg"
      ? { ...call, args: call.args.map((a) => (isReg(a) ? site.value : a)) }
      : { ...call, callee: { ...(call.callee as Extract<Expr, { k: "member" }>), obj: site.value } };
  return [...list.slice(0, site.defIndex), ...list.slice(site.defIndex + 1, site.useIndex), withCall(use, next), ...list.slice(site.useIndex + 1)];
}
