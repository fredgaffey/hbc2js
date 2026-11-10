// hermes-internal-dead-store matcher: one site, the whole current function
// body, exactly as `globalthis-dead-store` (one-shot fixed point).
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { DeadStoreAnalysis as Analysis } from "../ast.ts";
import { analyzeHermesInternal } from "./analysis.ts";

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], Analysis> | null {
  if (list !== ctx.fnBody) return null;
  const a = analyzeHermesInternal(list);
  if (a.deadStores.size === 0) return null;
  return { root: list, nodes: [list], data: a, at: { functionIndex: ctx.functionIndex, offset: 0 } };
}
