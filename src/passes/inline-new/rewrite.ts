// inline-new writer -- docs/specs/passes/24-class-recover.md section 9.
import type { Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";
import type { InlineNewGroup } from "./match.ts";
import { foldAll } from "./match.ts";

export function rewrite(m: Match<readonly Stmt[], InlineNewGroup>, _ctx: PassContext): readonly Stmt[] {
  return foldAll(m.nodes[0]!).after;
}
