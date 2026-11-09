import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { Analysis } from "../globalthis-dead-store/analysis.ts";
import { applyAnalysis } from "../globalthis-dead-store/analysis.ts";

export function rewrite(m: Match<readonly Stmt[], Analysis>, _ctx: PassContext): readonly Stmt[] {
  return applyAnalysis(m.nodes[0]!, m.data);
}
