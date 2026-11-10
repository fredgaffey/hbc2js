import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { DeadStoreAnalysis as Analysis } from "../ast.ts";
import { applyAnalysis } from "../ast.ts";

export function rewrite(m: Match<readonly Stmt[], Analysis>, _ctx: PassContext): readonly Stmt[] {
  return applyAnalysis(m.nodes[0]!, m.data);
}
