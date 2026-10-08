// array-literal writer — docs/specs/passes/31-array-literal.md §5.
import type { Expr, Stmt } from "../ast.ts";
import { inlineEmptyOf } from "./match.ts";
import type { ArrayLiteralMatch } from "./match.ts";

export function rewrite(m: ArrayLiteralMatch): readonly Stmt[] {
  const { root: list, data: site } = m;
  if (site.reg === null) {
    // The "already inlined" `k=0` form: recompute the same substitution
    // `match` found, deterministically, rather than carry a whole rebuilt
    // statement through the match data.
    const repl = inlineEmptyOf(list[site.defIndex]!);
    return [...list.slice(0, site.defIndex), repl!, ...list.slice(site.defIndex + 1)];
  }
  const def = list[site.defIndex]!;
  const value: Expr = { k: "array", elements: site.elements };
  // Spread the original statement so the `NewArray`'s own `origin` stamp
  // survives: the rebuilt literal really does come from that instruction.
  const repl: Stmt = { ...(def as Stmt & { readonly k: "expr" }), expr: { k: "assign", target: { k: "ident", name: site.reg }, value } };
  // docs/BUGS.md `array-literal-interleaved`: `hoisted` statements were
  // proven safe to commute above the whole run (`canHoist`) — moved here,
  // unmodified and in their original relative order, they are never deleted
  // the way a folded store is, only relocated (same pattern as
  // `object-literal`'s own writer).
  const span = site.count + site.hoisted.length;
  return [...list.slice(0, site.defIndex), ...site.hoisted, repl, ...list.slice(site.defIndex + 1 + span)];
}
